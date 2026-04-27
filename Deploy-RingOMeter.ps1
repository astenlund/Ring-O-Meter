<#
.SYNOPSIS
    Deploys Ring-O-Meter.Server to Azure Container Apps.

.DESCRIPTION
    Builds the multi-stage Docker image via `az acr build` (no local
    Docker required), pushes to ACR, and rolls the Container App to
    the new image. Three modes:

    - Default (code roll): build + push + roll the live image to a tag
      derived from the current commit.
    - -Bootstrap: first-time Bicep deploy with the public Microsoft
      Container Apps quickstart image as the initial container reference
      so the resource creates cleanly before any `ringometer-server`
      image exists in ACR.
    - -Infrastructure: infra-only Bicep redeploy that captures the
      currently-running image first via `az containerapp show`, then
      passes that image through to Bicep so the live app is not
      silently rolled back to the quickstart placeholder.

    The companion CI workflow (`.github/workflows/deploy-test.yml`)
    handles regular code rolls on push to `main`. This script covers
    manual bootstrap, infra redeploys, and out-of-band hotfix scenarios.
    See `infra/README.md` for the underlying `az` commands.

.PARAMETER Environment
    Target environment. Only `Test` exists today; the parameter accepts
    a single value but the shape is ready for `Prod` to be added.

.PARAMETER Bootstrap
    First-time Bicep deploy. Uses the public quickstart placeholder
    image so the Container App resource creates cleanly. After this
    completes, the script prints the exact command needed to grant
    `AcrPush` to the deploy service principal.

.PARAMETER Infrastructure
    Infra-only Bicep redeploy. Captures the current running image
    first, then runs Bicep with that image so the live app is not
    clobbered. Mutually exclusive with `-Bootstrap`.

.EXAMPLE
    .\Deploy-RingOMeter.ps1
    Builds and rolls a new image (default code-roll path).

.EXAMPLE
    .\Deploy-RingOMeter.ps1 -Bootstrap
    First-time deploy with the quickstart placeholder image.

.EXAMPLE
    .\Deploy-RingOMeter.ps1 -Infrastructure
    Bicep redeploy preserving the currently-running image.
#>

param(
    [ValidateSet("Test")]
    [string]$Environment = "Test",

    [switch]$Bootstrap,

    [switch]$Infrastructure
)

$ErrorActionPreference = "Stop"

$script:repoRoot = $PSScriptRoot

function Main {
    param(
        [string]$Environment,
        [switch]$Bootstrap,
        [switch]$Infrastructure
    )

    if ($Bootstrap -and $Infrastructure) {
        throw "Use -Bootstrap or -Infrastructure, not both. Bootstrap is the first deploy with a placeholder image; Infrastructure is for subsequent infra-only redeploys that preserve the live image."
    }

    Test-CleanGitWorkspace

    $names = Get-EnvironmentNames -TargetEnvironment $Environment

    if ($Bootstrap) {
        Invoke-BootstrapDeploy -Names $names
        return
    }

    if ($Infrastructure) {
        Invoke-InfraRedeploy -Names $names
        return
    }

    # Default path: code roll. Resolve the release-branch remote up
    # front so any interactive prompt happens before the long-running
    # build and roll steps.
    $branchRemote = Get-ReleaseBranchRemote
    Invoke-CodeRoll -Names $names -BranchRemote $branchRemote
}

function Test-CleanGitWorkspace {
    $gitStatus = git status --porcelain
    if ($gitStatus) {
        Write-Host "`nError: Git workspace has uncommitted changes.`n" -ForegroundColor Red
        Write-Host "The deployed image is tagged with the commit hash, which would not" -ForegroundColor Yellow
        Write-Host "reflect the actual content being deployed. Commit or stash changes" -ForegroundColor Yellow
        Write-Host "before deploying.`n" -ForegroundColor Yellow
        Write-Host "Changed files:" -ForegroundColor Gray
        $gitStatus | ForEach-Object { Write-Host "  $_" -ForegroundColor Gray }
        Write-Host ""
        throw "Deployment aborted: uncommitted changes detected."
    }
}

function Get-EnvironmentNames {
    param([string]$TargetEnvironment)

    $suffix = "-$($TargetEnvironment.ToLowerInvariant())"

    return [pscustomobject]@{
        Environment    = $TargetEnvironment
        ResourceGroup  = "rg-ringometer$suffix"
        ContainerApp   = "ca-ringometer$suffix"
        ImageName      = "ringometer-server"
        Location       = "swedencentral"
    }
}

function Get-AcrLoginServer {
    param([string]$ResourceGroup)

    $loginServer = az acr list `
        --resource-group $ResourceGroup `
        --query "[?starts_with(name, 'crringometer')].loginServer | [0]" -o tsv
    if ($LASTEXITCODE -ne 0 -or -not $loginServer) {
        throw "No ACR found in resource group '$ResourceGroup'. Has the bootstrap deploy run?"
    }

    return $loginServer
}

function Get-DeploymentName {
    param([string]$TargetEnvironment, [string]$Suffix)

    $timestamp = (Get-Date).ToUniversalTime().ToString("yyyyMMddTHHmmss")
    $env = $TargetEnvironment.ToLowerInvariant()
    if ($Suffix) {
        return "ringometer-$env-$Suffix-$timestamp"
    }

    return "ringometer-$env-$timestamp"
}

function Invoke-BootstrapDeploy {
    param([pscustomobject]$Names)

    Write-Host "`n======================================" -ForegroundColor Magenta
    Write-Host "  Bootstrap deploy: $($Names.Environment)" -ForegroundColor Magenta
    Write-Host "  Resource Group: $($Names.ResourceGroup)" -ForegroundColor Magenta
    Write-Host "======================================`n" -ForegroundColor Magenta

    Write-Host "Deploying infrastructure with the quickstart placeholder image..." -ForegroundColor Cyan

    $bicepFile = Join-Path $script:repoRoot "infra/main.bicep"
    $paramsFile = Join-Path $script:repoRoot "infra/main.test.bicepparam"
    $deploymentName = Get-DeploymentName -TargetEnvironment $Names.Environment -Suffix "bootstrap"

    az deployment sub create `
        --location $Names.Location `
        --name $deploymentName `
        --template-file $bicepFile `
        --parameters $paramsFile `
        --parameters containerImage="mcr.microsoft.com/k8se/quickstart:latest" `
        --output none
    if ($LASTEXITCODE -ne 0) {
        throw "Bootstrap Bicep deployment failed with exit code $LASTEXITCODE"
    }

    Write-Host "`nBootstrap deployment complete.`n" -ForegroundColor Green

    $loginServer = Get-AcrLoginServer -ResourceGroup $Names.ResourceGroup
    $registryName = $loginServer.Split('.')[0]

    Write-Host "Next step: grant AcrPush to the deploy service principal so CI can push images." -ForegroundColor Yellow
    Write-Host "Replace <SP_OBJECT_ID> with the deploy SP's object ID (see infra/README.md):" -ForegroundColor Gray
    Write-Host ""
    Write-Host "  ACR_ID=`$(az acr show --name $registryName --query id -o tsv)" -ForegroundColor Gray
    Write-Host "  az role assignment create ``" -ForegroundColor Gray
    Write-Host "    --assignee-object-id <SP_OBJECT_ID> --assignee-principal-type ServicePrincipal ``" -ForegroundColor Gray
    Write-Host "    --role AcrPush --scope `$ACR_ID" -ForegroundColor Gray
    Write-Host ""
    Write-Host "Then run a code-roll deploy: .\Deploy-RingOMeter.ps1" -ForegroundColor Yellow
}

function Invoke-InfraRedeploy {
    param([pscustomobject]$Names)

    Write-Host "`n======================================" -ForegroundColor Magenta
    Write-Host "  Infra redeploy: $($Names.Environment)" -ForegroundColor Magenta
    Write-Host "  Resource Group: $($Names.ResourceGroup)" -ForegroundColor Magenta
    Write-Host "======================================`n" -ForegroundColor Magenta

    # Capture the running image first so Bicep does not clobber it
    # back to the quickstart placeholder. This is the load-bearing
    # step described in infra/README.md.
    Write-Host "Capturing currently-running image..." -ForegroundColor Cyan
    $currentImage = az containerapp show `
        --resource-group $Names.ResourceGroup `
        --name $Names.ContainerApp `
        --query "properties.template.containers[0].image" -o tsv
    if ($LASTEXITCODE -ne 0 -or -not $currentImage) {
        throw "Could not read current image from Container App '$($Names.ContainerApp)'. Is it deployed?"
    }
    Write-Host "  Current image: $currentImage" -ForegroundColor Gray

    $bicepFile = Join-Path $script:repoRoot "infra/main.bicep"
    $paramsFile = Join-Path $script:repoRoot "infra/main.test.bicepparam"
    $deploymentName = Get-DeploymentName -TargetEnvironment $Names.Environment -Suffix "infra"

    Write-Host "`nRunning Bicep deployment with captured image..." -ForegroundColor Cyan
    az deployment sub create `
        --location $Names.Location `
        --name $deploymentName `
        --template-file $bicepFile `
        --parameters $paramsFile `
        --parameters containerImage="$currentImage" `
        --output none
    if ($LASTEXITCODE -ne 0) {
        throw "Infra redeploy failed with exit code $LASTEXITCODE"
    }

    Write-Host "`nInfra redeploy complete (image preserved at $currentImage).`n" -ForegroundColor Green

    Confirm-AppHealth -Names $Names
}

function Invoke-CodeRoll {
    param(
        [pscustomobject]$Names,
        [string]$BranchRemote
    )

    $commitHash = git rev-parse --short HEAD
    $commitMsg = git log -1 --format=%s

    Write-Host "`n======================================" -ForegroundColor Magenta
    Write-Host "  Code roll: $($Names.Environment)" -ForegroundColor Magenta
    Write-Host "  Resource Group: $($Names.ResourceGroup)" -ForegroundColor Magenta
    Write-Host "  Container App: $($Names.ContainerApp)" -ForegroundColor Magenta
    Write-Host "======================================`n" -ForegroundColor Magenta

    Write-Host "Deploying commit: $commitHash ($commitMsg)`n" -ForegroundColor Yellow

    $loginServer = Get-AcrLoginServer -ResourceGroup $Names.ResourceGroup
    $registryName = $loginServer.Split('.')[0]
    $imageTag = "$loginServer/$($Names.ImageName):$commitHash"

    # `az acr build` runs the multi-stage Dockerfile in Azure Container
    # Registry's build service (no local Docker required) and pushes
    # the result to ACR in the same step. Tag both <commit> and `latest`
    # so the latest reference always resolves to the most recent push.
    Write-Host "Building image in ACR (multi-stage: web + dotnet publish)..." -ForegroundColor Cyan
    Push-Location $script:repoRoot
    try {
        az acr build `
            --registry $registryName `
            --image "$($Names.ImageName):$commitHash" `
            --image "$($Names.ImageName):latest" `
            --file Dockerfile `
            .
        if ($LASTEXITCODE -ne 0) {
            throw "az acr build failed with exit code $LASTEXITCODE"
        }
    }
    finally {
        Pop-Location
    }

    Write-Host "`nRolling Container App to new image..." -ForegroundColor Cyan
    az containerapp update `
        --resource-group $Names.ResourceGroup `
        --name $Names.ContainerApp `
        --image $imageTag `
        --output none
    if ($LASTEXITCODE -ne 0) {
        throw "az containerapp update failed with exit code $LASTEXITCODE"
    }

    Write-Host "Container App rolled to $imageTag." -ForegroundColor Green

    Confirm-AppHealth -Names $Names

    # Move the release-{env} branch on the remote to HEAD, marking the
    # commit as released. Failures are non-fatal: the deploy already
    # succeeded and the branch is just a marker.
    Update-ReleaseBranch -TargetEnvironment $Names.Environment -BranchRemote $BranchRemote
}

function Confirm-AppHealth {
    param([pscustomobject]$Names)

    Write-Host "`nWaiting for Container App to become healthy..." -ForegroundColor Yellow

    $fqdn = az containerapp show `
        --resource-group $Names.ResourceGroup `
        --name $Names.ContainerApp `
        --query "properties.configuration.ingress.fqdn" -o tsv
    if ($LASTEXITCODE -ne 0 -or -not $fqdn) {
        Write-Host "Warning: could not resolve Container App FQDN; skipping health check." -ForegroundColor Yellow
        return
    }

    $healthUrl = "https://$fqdn/health"
    $maxAttempts = 12
    $attempt = 0
    while ($attempt -lt $maxAttempts) {
        $attempt++
        try {
            $response = Invoke-RestMethod -Uri $healthUrl -TimeoutSec 10 -ErrorAction Stop
            Write-Host "Container App is healthy: status=$($response.status)" -ForegroundColor Green
            Write-Host "  URL: https://$fqdn" -ForegroundColor Yellow
            Write-Host "  COI check: https://$fqdn/coi-check.html" -ForegroundColor Yellow

            return
        }
        catch {
            if ($attempt -eq $maxAttempts) {
                Write-Host "Warning: health check timed out at $healthUrl. The app may still be starting." -ForegroundColor Yellow

                return
            }

            Write-Host "  Attempt $attempt/$maxAttempts - waiting..." -ForegroundColor Gray
            Start-Sleep -Seconds 5
        }
    }
}

# Prompt the user to pick from a list of choices using PowerShell's host UI.
function AskUser {
    param (
        [Parameter(Position=0)]            [string]$Caption,
        [Parameter(Position=1, Mandatory)] [string]$Message,
        [Parameter(Position=2, Mandatory)] [string[]]$Choices,
        [Parameter(Position=3)]            [string]$DefaultChoice,
        [Parameter(Position=4)]            [hashtable]$HelpMessages = @{}
    )

    [System.Management.Automation.Host.ChoiceDescription[]]$ChoiceDescriptions = @()

    foreach ($Choice in $Choices) {
        if (-not $HelpMessages.ContainsKey($Choice)) {
            $HelpMessages[$Choice] = $Choice.Trim("&")
        }

        $ChoiceDescriptions += New-Object System.Management.Automation.Host.ChoiceDescription $Choice, $HelpMessages[$Choice]
    }

    $DefaultChoiceIndex = [array]::IndexOf(($ChoiceDescriptions | Select-Object -ExpandProperty Label), "$DefaultChoice")
    $Result = $Host.Ui.PromptForChoice($Caption, $Message, $ChoiceDescriptions, $DefaultChoiceIndex)

    return @($ChoiceDescriptions | Select-Object -ExpandProperty Label)[$Result]
}

# Resolve the remote that should receive release branches.
# First run with multiple remotes prompts the user and remembers the
# chosen URL in git config (deploy.publicRemoteUrl). Subsequent runs
# look up the current remote name by URL, so renaming the remote
# locally does not break anything.
function Get-ReleaseBranchRemote {
    $remotes = @(git remote)
    if ($remotes.Count -eq 0) {
        return $null
    }

    if ($remotes.Count -eq 1) {
        return $remotes[0]
    }

    $savedUrl = git config --get deploy.publicRemoteUrl 2>$null
    if ($LASTEXITCODE -eq 0 -and $savedUrl) {
        foreach ($remote in $remotes) {
            $url = git remote get-url $remote 2>$null
            if ($LASTEXITCODE -eq 0 -and $url -eq $savedUrl) {
                return $remote
            }
        }

        Write-Host "Saved deploy remote URL '$savedUrl' no longer matches any configured remote; re-prompting." -ForegroundColor Yellow
    }

    # Numeric accelerators (&1, &2, ...) avoid collisions when remote
    # names share a first character.
    $choices = @()
    $helpMessages = @{}
    $labelToRemote = @{}
    for ($i = 0; $i -lt $remotes.Count; $i++) {
        $remote = $remotes[$i]
        $url = git remote get-url $remote 2>$null
        $label = "&$($i + 1) $remote"
        $choices += $label
        $helpMessages[$label] = "$remote ($url)"
        $labelToRemote[$label] = $remote
    }

    try {
        $chosenLabel = AskUser -Caption "Select release branch remote" `
            -Message "Which remote should receive release branches? This will be remembered for future deploys." `
            -Choices $choices `
            -HelpMessages $helpMessages
    }
    catch {
        Write-Host "Warning: could not prompt for release branch remote ($($_.Exception.Message)); skipping branch push." -ForegroundColor Yellow

        return $null
    }

    $chosenRemote = $labelToRemote[$chosenLabel]
    $chosenUrl = git remote get-url $chosenRemote 2>$null
    if ($LASTEXITCODE -eq 0 -and $chosenUrl) {
        git config --local deploy.publicRemoteUrl $chosenUrl | Out-Null
        Write-Host "Remembered '$chosenRemote' ($chosenUrl) as the release branch remote." -ForegroundColor Gray
    }

    return $chosenRemote
}

# Move the release-{env} branch on the remote to HEAD, marking the
# commit as released. Failures are non-fatal: the deploy already
# succeeded, the branch is just a marker.
function Update-ReleaseBranch {
    param(
        [string]$TargetEnvironment,
        [string]$BranchRemote
    )

    $branchName = "release-$($TargetEnvironment.ToLowerInvariant())"

    Write-Host "`nUpdating release branch '$branchName' to HEAD..." -ForegroundColor Cyan

    if (-not $BranchRemote) {
        Write-Host "Warning: no git remote selected; skipping branch push." -ForegroundColor Yellow

        return
    }

    git push --force $BranchRemote "HEAD:refs/heads/$branchName"
    if ($LASTEXITCODE -ne 0) {
        Write-Host "Warning: failed to push branch '$branchName' to '$BranchRemote' (exit $LASTEXITCODE)" -ForegroundColor Yellow

        return
    }

    Write-Host "Release branch '$branchName' updated on '$BranchRemote'." -ForegroundColor Green
}

# Forward parameters explicitly rather than via @PSBoundParameters so
# the script-level default for $Environment ("Test") propagates when
# the caller omits it. PSBoundParameters only carries explicitly-bound
# parameters; FeatherPod's inspiration shape uses [Mandatory] on
# Environment and so doesn't hit this case.
Main -Environment $Environment -Bootstrap:$Bootstrap -Infrastructure:$Infrastructure

# Infra (slice 1a)

Trimmed Azure deployment: a single test environment in Sweden Central
(`rg-ringometer-test`) hosting the RingOMeter.Server static-file host
on Azure Container Apps Consumption tier with HTTPS termination and
COOP/COEP for SharedArrayBuffer. The full deployment design lives in
`.claude/features/azure-deployment.md`; this slice ships the subset
needed to unblock Phase 2 of the rendering-diagnostics plan.

## One-time setup

Run these once per environment, on a developer machine with `az` CLI
authenticated against the target subscription. Subsequent deploys go
through CI (`.github/workflows/deploy-test.yml`).

### 1. Federated identity for GitHub Actions OIDC

Replace `<owner>/<repo>` with the actual GitHub path and run from a
shell with `az` logged in.

```bash
# Create an AAD app registration that GitHub Actions will impersonate.
APP_ID=$(az ad app create --display-name "ringometer-deploy-test" --query appId -o tsv)
az ad sp create --id "$APP_ID"

# Federated credential bound to pushes on main.
az ad app federated-credential create --id "$APP_ID" --parameters '{
  "name": "github-main",
  "issuer": "https://token.actions.githubusercontent.com",
  "subject": "repo:<owner>/<repo>:ref:refs/heads/main",
  "audiences": ["api://AzureADTokenExchange"]
}'

# RBAC grants. AcrPush on the registry once it exists; Contributor scoped
# to the test RG for `az containerapp update` and Bicep redeploys.
SUB_ID=$(az account show --query id -o tsv)
SP_ID=$(az ad sp show --id "$APP_ID" --query id -o tsv)

az role assignment create \
  --assignee-object-id "$SP_ID" --assignee-principal-type ServicePrincipal \
  --role "Contributor" \
  --scope "/subscriptions/$SUB_ID/resourceGroups/rg-ringometer-test"

# AcrPush is added after the first bootstrap deploy creates the registry.
# Re-run this section's last command then.
```

Record `APP_ID` and the Azure tenant + subscription IDs as GitHub
Actions repository secrets:

- `AZURE_CLIENT_ID` = `$APP_ID`
- `AZURE_TENANT_ID` = output of `az account show --query tenantId -o tsv`
- `AZURE_SUBSCRIPTION_ID` = `$SUB_ID`

### 2. Bootstrap deploy

The very first deploy creates the resource group, registry, identity,
monitoring stack, Container Apps environment, and Container App. The
Container App requires a valid image at creation time but no
ringometer-server image exists in ACR yet, so we point at the public
Container Apps quickstart image. The CI pipeline replaces it on the
first push to `main`.

```bash
az deployment sub create \
  --location swedencentral \
  --name ringometer-test-bootstrap \
  --template-file infra/main.bicep \
  --parameters infra/main.test.bicepparam \
  --parameters containerImage=mcr.microsoft.com/k8se/quickstart:latest
```

Record the outputs:

- `containerAppFqdn` is the public HTTPS URL.
- `registryLoginServer` is the ACR login server (CI uses it).
- `identityClientId` and `identityPrincipalId` are the MI's GUIDs.

After this, complete the AcrPush grant:

```bash
ACR_ID=$(az acr show --name <registry-name> --query id -o tsv)
az role assignment create \
  --assignee-object-id "$SP_ID" --assignee-principal-type ServicePrincipal \
  --role "AcrPush" --scope "$ACR_ID"
```

## Subsequent operations

### Image rolls (CI)

Every push to `main` triggers `.github/workflows/deploy-test.yml`,
which builds the multi-stage Docker image, pushes to ACR, and rolls
the Container App via `az containerapp update --image`. Bicep is not
involved.

### Infra-only redeploys (manual, rare)

When the Bicep itself changes (new module, new RBAC grant, settings
adjustment), redeploy from a developer machine. **Capture the current
running image first** so Bicep does not clobber it back to the
quickstart image (see slice-1a plan section 2g):

```bash
CURRENT_IMAGE=$(az containerapp show \
  --resource-group rg-ringometer-test \
  --name ca-ringometer-test \
  --query properties.template.containers[0].image -o tsv)

az deployment sub create \
  --location swedencentral \
  --name ringometer-test-$(date -u +%Y%m%dT%H%M%S) \
  --template-file infra/main.bicep \
  --parameters infra/main.test.bicepparam \
  --parameters containerImage="$CURRENT_IMAGE"
```

The `containerImage` parameter has no default in `main.bicep`; if you
forget the override, the deployment fails loudly instead of silently
rolling the live app back to the quickstart image.

A second CI workflow (`.github/workflows/deploy-infra.yml` triggered
on `infra/**` paths) is the natural next step but is deferred until
there is operational experience with the infra-change cadence.

## Deferred from `azure-deployment.md`

Slice 1a explicitly does NOT ship: Storage Account, prod RG, custom
domain, Key Vault, three-RG split. Each grows back as later slices
need it; see `.claude/features/azure-deployment.md` for the canonical
full design.

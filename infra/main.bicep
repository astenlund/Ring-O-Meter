// Slice 1a: trimmed test-environment infrastructure for hosting the
// RingOMeter.Server static-file host on Azure Container Apps. Trimmed
// from the full design in .claude/features/azure-deployment.md; the
// deferred resources (Storage, prod RG, custom domain, Key Vault) grow
// back as later slices need them.
//
// Bootstrap and redeploy lifecycle is described in section 2g of the
// slice-1a plan and infra/README.md. The TL;DR: containerImage is a
// required parameter (no default) so a forgotten override fails loudly
// instead of silently rolling the live app back to the quickstart
// image. CI captures the current image via az containerapp show before
// any infra-only redeploy and passes it through.
targetScope = 'subscription'

@description('Resource group name for the test environment.')
param resourceGroupName string = 'rg-ringometer-test'

@description('Azure region. Sweden Central is the primary deploy target per the project working hypothesis.')
param location string = 'swedencentral'

@description('Container image reference. REQUIRED on every deploy. Bootstrap value: mcr.microsoft.com/k8se/quickstart:latest. Subsequent deploys: capture the running image via az containerapp show first (see infra/README.md).')
param containerImage string

@description('Container Apps min replica count. 0 enables scale-to-zero.')
param containerAppMinReplicas int = 0

@description('Container Apps max replica count.')
param containerAppMaxReplicas int = 1

@description('Log Analytics retention in days. The PerGB2018 SKU enforces a 30-day floor; the first 31 days are free under that SKU so 30 is the cheapest valid value.')
param logRetentionDays int = 30

@description('Log Analytics workspace daily ingestion cap (GB).')
param logsDailyCapGb int = 1

resource rg 'Microsoft.Resources/resourceGroups@2025-04-01' = {
  name: resourceGroupName
  location: location
}

module identity 'modules/identity.bicep' = {
  scope: rg
  name: 'identity'
  params: {
    location: location
    name: 'id-ringometer-test'
  }
}

module monitoring 'modules/monitoring.bicep' = {
  scope: rg
  name: 'monitoring'
  params: {
    location: location
    workspaceName: 'log-ringometer-test'
    appInsightsName: 'appi-ringometer-test'
    retentionInDays: logRetentionDays
    dailyCapGb: logsDailyCapGb
  }
}

module registry 'modules/containerRegistry.bicep' = {
  scope: rg
  name: 'registry'
  params: {
    location: location
    name: 'crringometer${uniqueString(rg.id)}'
  }
}

module env 'modules/containerAppsEnv.bicep' = {
  scope: rg
  name: 'env'
  params: {
    location: location
    name: 'cae-ringometer-test'
    workspaceCustomerId: monitoring.outputs.workspaceCustomerId
    workspaceSharedKey: monitoring.outputs.workspaceSharedKey
  }
}

module app 'modules/containerApp.bicep' = {
  scope: rg
  name: 'app'
  params: {
    location: location
    name: 'ca-ringometer-test'
    environmentId: env.outputs.id
    identityId: identity.outputs.id
    image: containerImage
    registryLoginServer: registry.outputs.loginServer
    minReplicas: containerAppMinReplicas
    maxReplicas: containerAppMaxReplicas
  }
}

module rbac 'modules/rbac.bicep' = {
  scope: rg
  name: 'rbac'
  params: {
    identityPrincipalId: identity.outputs.principalId
    registryName: registry.outputs.name
    appInsightsName: monitoring.outputs.appInsightsName
  }
}

output containerAppFqdn string = app.outputs.fqdn
output registryLoginServer string = registry.outputs.loginServer
output identityClientId string = identity.outputs.clientId
output identityPrincipalId string = identity.outputs.principalId

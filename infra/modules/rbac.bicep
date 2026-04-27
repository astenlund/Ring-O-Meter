// Single source of truth for every role assignment in the slice-1a
// stack. Audit by reading this file end-to-end. Slice 1b grows it
// (probably Storage roles when persistence lands); keep this module
// the only place new role assignments are declared.

@description('Principal ID (object/SP guid) of the user-assigned managed identity. NOT the resource ID.')
param identityPrincipalId string

@description('Container Registry name to scope AcrPull.')
param registryName string

@description('Application Insights component name to scope Monitoring Metrics Publisher.')
param appInsightsName string

// Built-in role definition GUIDs.
var acrPullRoleId = '7f951dda-4ed3-4680-a7ca-43fe172d538d'
var monitoringMetricsPublisherRoleId = '3913510d-42f4-4e42-8a64-420c390055eb'

resource registry 'Microsoft.ContainerRegistry/registries@2023-11-01-preview' existing = {
  name: registryName
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' existing = {
  name: appInsightsName
}

resource acrPull 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: registry
  name: guid(registry.id, identityPrincipalId, acrPullRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', acrPullRoleId)
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

resource metricsPublisher 'Microsoft.Authorization/roleAssignments@2022-04-01' = {
  scope: appInsights
  name: guid(appInsights.id, identityPrincipalId, monitoringMetricsPublisherRoleId)
  properties: {
    roleDefinitionId: subscriptionResourceId('Microsoft.Authorization/roleDefinitions', monitoringMetricsPublisherRoleId)
    principalId: identityPrincipalId
    principalType: 'ServicePrincipal'
  }
}

@description('Azure region.')
param location string

@description('Log Analytics workspace name.')
param workspaceName string

@description('Application Insights component name.')
param appInsightsName string

@description('Workspace data retention in days.')
param retentionInDays int = 7

@description('Workspace daily ingestion cap (GB).')
param dailyCapGb int = 1

resource workspace 'Microsoft.OperationalInsights/workspaces@2023-09-01' = {
  name: workspaceName
  location: location
  properties: {
    sku: {
      name: 'PerGB2018'
    }
    retentionInDays: retentionInDays
    workspaceCapping: {
      dailyQuotaGb: dailyCapGb
    }
    features: {
      enableLogAccessUsingOnlyResourcePermissions: true
    }
  }
}

resource appInsights 'Microsoft.Insights/components@2020-02-02' = {
  name: appInsightsName
  location: location
  kind: 'web'
  properties: {
    Application_Type: 'web'
    WorkspaceResourceId: workspace.id
    IngestionMode: 'LogAnalytics'
  }
}

output workspaceId string = workspace.id
#disable-next-line outputs-should-not-contain-secrets
output workspaceCustomerId string = workspace.properties.customerId
#disable-next-line outputs-should-not-contain-secrets
output workspaceSharedKey string = workspace.listKeys().primarySharedKey
output appInsightsId string = appInsights.id
output appInsightsName string = appInsights.name
output appInsightsConnectionString string = appInsights.properties.ConnectionString

@description('Azure region.')
param location string

@description('Container Apps managed environment name.')
param name string

@description('Log Analytics workspace customer ID for app log destination.')
@secure()
param workspaceCustomerId string

@description('Log Analytics workspace shared key for app log destination.')
@secure()
param workspaceSharedKey string

resource env 'Microsoft.App/managedEnvironments@2024-03-01' = {
  name: name
  location: location
  properties: {
    appLogsConfiguration: {
      destination: 'log-analytics'
      logAnalyticsConfiguration: {
        customerId: workspaceCustomerId
        sharedKey: workspaceSharedKey
      }
    }
    workloadProfiles: [
      {
        name: 'Consumption'
        workloadProfileType: 'Consumption'
      }
    ]
  }
}

output id string = env.id
output defaultDomain string = env.properties.defaultDomain

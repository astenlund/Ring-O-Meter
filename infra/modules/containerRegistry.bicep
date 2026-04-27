@description('Azure region.')
param location string

@description('Registry name. 5-50 alphanumerics, globally unique.')
param name string

resource registry 'Microsoft.ContainerRegistry/registries@2023-07-01' = {
  name: name
  location: location
  sku: {
    name: 'Basic'
  }
  properties: {
    adminUserEnabled: false
    publicNetworkAccess: 'Enabled'
  }
}

output id string = registry.id
output name string = registry.name
output loginServer string = registry.properties.loginServer

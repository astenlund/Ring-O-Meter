@description('Azure region.')
param location string

@description('Container App name.')
param name string

@description('Container Apps Environment resource ID.')
param environmentId string

@description('User-assigned managed identity resource ID (used for AcrPull and any future managed-identity auth).')
param identityId string

@description('Container image reference. Bootstrap deploy uses mcr.microsoft.com/k8se/quickstart:latest; subsequent deploys pass the current running image (captured via az containerapp show) so Bicep does not clobber it.')
param image string

@description('ACR login server (e.g., crringometer<suffix>.azurecr.io). Used as the registry source for managed-identity pulls.')
param registryLoginServer string

@description('Min replica count. 0 enables scale-to-zero.')
param minReplicas int = 0

@description('Max replica count.')
param maxReplicas int = 1

@description('Container target port. .NET 10 minimal-API host listens on 8080 by default in container images.')
param targetPort int = 8080

resource app 'Microsoft.App/containerApps@2024-03-01' = {
  name: name
  location: location
  identity: {
    type: 'UserAssigned'
    userAssignedIdentities: {
      '${identityId}': {}
    }
  }
  properties: {
    environmentId: environmentId
    configuration: {
      ingress: {
        external: true
        targetPort: targetPort
        transport: 'auto'
        allowInsecure: false
        traffic: [
          {
            latestRevision: true
            weight: 100
          }
        ]
      }
      registries: [
        {
          server: registryLoginServer
          identity: identityId
        }
      ]
    }
    template: {
      containers: [
        {
          name: 'server'
          image: image
          resources: {
            cpu: json('0.5')
            memory: '1Gi'
          }
          probes: [
            {
              type: 'Liveness'
              httpGet: {
                path: '/health'
                port: targetPort
              }
              initialDelaySeconds: 10
              periodSeconds: 30
            }
            {
              type: 'Readiness'
              httpGet: {
                path: '/health'
                port: targetPort
              }
              initialDelaySeconds: 5
              periodSeconds: 10
            }
          ]
        }
      ]
      scale: {
        minReplicas: minReplicas
        maxReplicas: maxReplicas
      }
    }
  }
}

output id string = app.id
output fqdn string = app.properties.configuration.ingress.fqdn

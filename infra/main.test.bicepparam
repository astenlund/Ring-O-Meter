using 'main.bicep'

param resourceGroupName = 'rg-ringometer-test'
param location = 'swedencentral'
param containerAppMinReplicas = 0
param containerAppMaxReplicas = 1
param logRetentionDays = 30
param logsDailyCapGb = 1

// containerImage is set to a deliberately-invalid sentinel so a
// forgotten CLI override fails fast (the registry rejects the pull)
// instead of silently rolling the live app back to a known-good
// default. Always supply -p containerImage=<value> on the deploy
// command. See infra/README.md and slice-1a plan section 2g.
param containerImage = 'OVERRIDE_REQUIRED_VIA_CLI_SEE_INFRA_README'

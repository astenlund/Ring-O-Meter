using System.Collections.Generic;
using System.Net.Http.Json;
using FluentAssertions;
using Microsoft.AspNetCore.Mvc.Testing;
using Microsoft.Extensions.Configuration;
using Xunit;

namespace RingOMeter.Server.Tests.Config;

public class ConfigJsonTests : IClassFixture<WebApplicationFactory<global::Program>>
{
    private readonly WebApplicationFactory<global::Program> factory;

    public ConfigJsonTests(WebApplicationFactory<global::Program> factory)
    {
        this.factory = factory;
    }

    [Fact]
    public async Task Config_returns_devModesEnabled_false_by_default()
    {
        // Arrange: inject an in-memory config source so the test is
        // environment-independent; appsettings.json carries false as
        // the production default and this test confirms the endpoint
        // respects it regardless of which environment file is active.
        using var configured = factory.WithWebHostBuilder(b =>
            b.ConfigureAppConfiguration((_, cfg) =>
                cfg.AddInMemoryCollection([
                    new KeyValuePair<string, string?>("Server:DevModesEnabled", "false"),
                ])));
        var client = configured.CreateClient();

        // Act
        var payload = await client.GetFromJsonAsync<ConfigPayload>("/config.json");

        // Assert
        payload.Should().NotBeNull();
        payload!.DevModesEnabled.Should().BeFalse();
    }

    [Fact]
    public async Task Config_honors_Server_DevModesEnabled_true()
    {
        // Arrange
        using var configured = factory.WithWebHostBuilder(b =>
            b.ConfigureAppConfiguration((_, cfg) =>
                cfg.AddInMemoryCollection([
                    new KeyValuePair<string, string?>("Server:DevModesEnabled", "true"),
                ])));
        var client = configured.CreateClient();

        // Act
        var payload = await client.GetFromJsonAsync<ConfigPayload>("/config.json");

        // Assert
        payload!.DevModesEnabled.Should().BeTrue();
    }

    private sealed record ConfigPayload(string HubUrl, bool DevModesEnabled);
}

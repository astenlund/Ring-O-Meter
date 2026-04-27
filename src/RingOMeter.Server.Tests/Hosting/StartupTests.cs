using FluentAssertions;
using Microsoft.AspNetCore.Hosting;
using Microsoft.AspNetCore.Mvc.Testing;

namespace RingOMeter.Server.Tests.Hosting;

public class StartupTests
{
    [Fact]
    public async Task Server_starts_without_any_azure_environment_variable()
    {
        // Arrange: WebApplicationFactory boots the host with ASPNETCORE_ENVIRONMENT=Test
        // (an ASP.NET hosting variable, not an Azure variable). No AZURE_*,
        // APPLICATIONINSIGHTS_CONNECTION_STRING, or managed-identity client-id is set
        // anywhere in the configuration. If a future change to Program.cs ever requires
        // such a variable at startup, this test fails when the host can no longer build.
        await using var factory = new WebApplicationFactory<global::Program>()
            .WithWebHostBuilder(b => b.UseEnvironment("Test"));
        using var client = factory.CreateClient();

        // Act
        var response = await client.GetAsync("/health");

        // Assert
        response.IsSuccessStatusCode.Should().BeTrue();
    }
}

// COOP/COEP headers are required for SharedArrayBuffer to work in the
// browser. This is the fourth lockstep location for the same two header
// values. The set:
//   web/vite.config.ts                (server + preview blocks)
//   web/vitest.browser.config.ts      (Vitest browser-mode test host)
//   src/RingOMeter.Server/Program.cs  (this file, deployed server)
// If you change the values in any one of these, change the others.
// Diagnostic: if `self.crossOriginIsolated` is false in any environment,
// one of these locations is out of sync.
var builder = WebApplication.CreateBuilder(args);

var app = builder.Build();

app.Use(async (context, next) =>
{
    context.Response.Headers["Cross-Origin-Opener-Policy"] = "same-origin";
    context.Response.Headers["Cross-Origin-Embedder-Policy"] = "require-corp";
    await next();
});

app.UseDefaultFiles();
app.UseStaticFiles();

app.MapGet("/health", () => Results.Ok(new { status = "ok" }));

app.MapGet("/config.json", (IConfiguration config) =>
    Results.Ok(new { hubUrl = config["Server:HubUrl"] ?? string.Empty }));

app.Run();

// Exposed so WebApplicationFactory<Program> in RingOMeter.Server.Tests can
// reach the entry point. Top-level statements emit an internal Program by
// default; this declaration widens just enough for test access without
// pulling in InternalsVisibleTo.
public partial class Program
{
}

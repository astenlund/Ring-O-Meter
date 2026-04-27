// COOP/COEP headers are required for SharedArrayBuffer to work in the
// browser. This file is one of the lockstep locations for the same two
// header values. The set:
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
    var headers = context.Response.Headers;
    headers["Cross-Origin-Opener-Policy"] = "same-origin";
    headers["Cross-Origin-Embedder-Policy"] = "require-corp";
    headers["X-Content-Type-Options"] = "nosniff";
    headers["Strict-Transport-Security"] = "max-age=31536000";
    await next();
});

app.UseDefaultFiles();
app.UseStaticFiles();

// /health is hit by Container Apps' liveness probe every 30s and the
// readiness probe every 10s; pre-allocating the response avoids a fresh
// anonymous-object allocation per probe, matching the alloc-discipline
// convention used elsewhere in the codebase.
var healthBody = new { status = "ok" };
app.MapGet("/health", () => Results.Ok(healthBody));

// /config.json is hit at most once per SPA page load and reads
// IConfiguration each call rather than freezing at startup. Freezing
// would silently mask a Server:HubUrl env-var change after deploy
// (slice 1b will populate this); per-request read keeps the endpoint
// honest and the alloc cost is irrelevant at SPA-startup cadence.
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

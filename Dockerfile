# Multi-stage build for the slice-1a hosting target. Stage 1 builds the
# slice-0 web bundle. Stage 2 publishes the ASP.NET Core server. Stage 3
# is the runtime layer; the published app's wwwroot is populated with
# the web bundle from stage 1 so the deployed image carries the SPA
# inside the server image (single artefact, single rollback unit).

# Stage 1: build the web bundle.
FROM node:22-alpine AS web-build
WORKDIR /src

# node:22-alpine does not preinstall pnpm. Activate it via Corepack:
# `corepack enable` adds the pnpm shim, then `pnpm install` triggers
# auto-activation of the version pinned in web/package.json's
# packageManager field. The field's `+sha512.<hash>` integrity suffix
# is what tells Corepack to skip the interactive prompt; the
# COREPACK_ENABLE_DOWNLOAD_PROMPT=0 env var is defense-in-depth for
# Corepack version differences.
ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0

COPY web/package.json web/pnpm-lock.yaml ./web/
RUN corepack enable
RUN cd web && pnpm install --frozen-lockfile

COPY web ./web
RUN cd web && pnpm build


# Stage 2: build and publish the server.
FROM mcr.microsoft.com/dotnet/sdk:10.0-alpine AS server-build
WORKDIR /src

COPY .editorconfig Directory.Build.props global.json stylecop.json ./
COPY src/RingOMeter.Domain src/RingOMeter.Domain
COPY src/RingOMeter.Server src/RingOMeter.Server

RUN dotnet publish src/RingOMeter.Server/RingOMeter.Server.csproj \
    -c Release \
    -o /app/publish

# Stitch the built web bundle into the server's wwwroot. The server
# csproj has no <Content Include> for web/dist (the two halves build
# independently); the explicit COPY is what unifies them.
COPY --from=web-build /src/web/dist /app/publish/wwwroot


# Stage 3: runtime.
FROM mcr.microsoft.com/dotnet/aspnet:10.0-alpine AS runtime
WORKDIR /app

COPY --from=server-build /app/publish ./

# ASPNETCORE_URLS keeps the listener consistent across host platforms;
# Container Apps' targetPort in the Bicep is 8080.
ENV ASPNETCORE_URLS=http://+:8080
EXPOSE 8080

ENTRYPOINT ["dotnet", "RingOMeter.Server.dll"]

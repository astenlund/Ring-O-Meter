# Ring-O-Meter

A browser-based tuning and vowel-matching companion for barbershop quartets.

## Local development

### Prerequisites

- .NET 10 SDK
- Node.js 22+ and pnpm 10+

### One-time setup per clone

Set the project-local hooks path so the pre-commit hook runs:

```
git config core.hooksPath hooks
```

### Run the web app

Slice 0 is browser-only; the server arrives in slice 1.

```
cd web
pnpm install
pnpm dev
```

Open the printed URL (typically `http://localhost:5173`).

## Tests

```
dotnet test --filter Category!=Integration
cd web && pnpm test
```

`dotnet test` without `--filter` runs the full suite including any future
integration tests; prefer the filtered form during normal development.

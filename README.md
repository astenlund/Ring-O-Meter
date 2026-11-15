# Ring-O-Meter

A browser-based tuning and vowel-matching companion for barbershop quartets.

## Local development

### Prerequisites

- .NET 10 SDK
- Node.js 22+ and pnpm 10+
- bash for the pre-commit hook (3.2 or newer, so the macOS system bash works; Git for Windows includes one)

### One-time setup per clone

Set the project-local hooks path so the pre-commit hook runs:

```
git config core.hooksPath hooks
```

If your user- or system-level Git config already sets `core.hooksPath`, the local setting replaces it, so the project hook runs that directory's `pre-commit` itself after its own checks.

The hook auto-fixes staged C# and web files and re-stages them whole, so it refuses a commit that stages only part of such a file and names the file; stage or stash the rest of it, then commit again.

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
(cd web && pnpm test)
bash hooks/test-pre-commit.sh
```

`dotnet test` without `--filter` runs the full suite including any future integration tests; prefer the filtered form during normal development. `hooks/test-pre-commit.sh` exercises the pre-commit hook's staging logic in throwaway repositories with stub formatters.

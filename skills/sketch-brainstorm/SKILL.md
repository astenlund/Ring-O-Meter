---
name: sketch-brainstorm
description: Round-trip UI brainstorm loop with a reMarkable tablet. Use when the user wants to sketch on the tablet ("push to tablet", "send sketch to remarkable", "brainstorm UI on the tablet", "pull from tablet", "grab the annotated version"). Renders HTML mockups to PDF at the tablet's viewport, pushes to the reMarkable cloud via rmapi, polls for annotations (future slice), interprets pen marks, iterates.
---

# sketch-brainstorm

A skill for design-iteration with handwritten annotations on a reMarkable tablet. The user sketches reactions on the tablet, Claude reads the marks and emits the next mockup.

## STATUS: render + push walking skeleton

Outbound is now end-to-end: render a two-page PDF locally, push it to a folder on the reMarkable cloud via rmapi. Inbound stroke parsing also works locally from a manually-extracted `.rmdoc` archive.

- `render-html-to-pdf.sh` produces a two-page PDF at the Paper Pro viewport from a parametrised HTML template. Page 1 is the mockup page (header, mockup region, small notes area, chrome footer with the Finish-turn checkbox); page 2 is the legend page (header, vocabulary legend, larger notes area, mirrored chrome footer). The user can append further pages on the tablet for long-form notes (handled by the future interpretation slice).
- `push-to-tablet.sh` uploads a rendered PDF to a named cloud folder via `rmapi put --force`. Owns just the upload step; cloud-path composition (project root + per-session slug) belongs to the future bootstrap-dialogue slice that calls this wrapper.
- `render-strokes.sh` converts per-page `.rm` stroke files (from a locally extracted `.rmdoc` archive) to SVG overlays at the same viewport dimensions as the PDF. Bootstraps a Python venv with `rmscene` on first run.

Not yet implemented (deferred to follow-up plans):

- `rmapi get` pull + automated `.rmdoc` extraction (today the user runs `rmapi get` and unzips manually before invoking `render-strokes.sh`)
- Auth bootstrap (`setup-rmapi.sh`, `~/.rmapi` token, deny rules, PreToolUse hook); the push wrapper assumes the machine is already paired
- Bootstrap dialogue (precondition check, topic prompt, cloud path resolution, design-language briefing)
- Background polling script and pixel-region checkbox sentinel (color-aware detection sampled from the pre-render baseline)
- Per-rendered-page interpretation pipeline (pre-render + strokes + annotated composite) feeding a fresh subagent; user-added pages 3+ pass through as additional stroke views
- Multi-sketch iterations (N rendered sketches plus a trailing legend page, for side-by-side alternatives)
- Verify-before-push (visual sanity check on the rendered output before pushing)
- iter01+ loop and `design-state.md` append protocol
- B&W and Wireframe render modes (Color is current default and only mode)
- Vocabulary lifecycle (weight-based active / archived split, frecency-style scoring) and close-session ceremony

When asked to drive a full round-trip today, surface that the polling + interpretation halves are not implemented yet and point at the feature spec for the full design.

## Files in this skill

- `SKILL.md` -- this file.
- `README.md` -- condensed design rationale for the skill.
- `vocabulary.md` -- canonical core vocabulary table (gestures and their meanings).
- `render/page-template.html` -- HTML template with `{{topic}}`, `{{iteration_label}}`, `{{mockup_html}}` tokens.
- `render/page-chrome.css` -- styles for header strip, notes region, legend, and Finish-turn checkbox.
- `render/render.mjs` -- Node ESM script that substitutes tokens, launches Chromium, and writes the PDF.
- `render-html-to-pdf.sh` -- bash wrapper around `render.mjs`. Outbound render entry point.
- `push-to-tablet.sh` -- bash wrapper for `rmapi put`; outbound cloud upload entry point.
- `render/render-strokes.py` -- converts per-page `.rm` stroke files to SVG overlays.
- `render-strokes.sh` -- bash wrapper for the inbound stroke pipeline; bootstraps Python venv.
- `requirements.txt` -- Python deps for the inbound pipeline (rmscene).

## Inbound stroke render entry point

After pulling an annotated `.rmdoc` archive with `rmapi get` and extracting it:

```
bash .claude/skills/sketch-brainstorm/render-strokes.sh \
  <rm-dir> \
  .tmp/sketch-brainstorm/test/strokes-out/
```

- `<rm-dir>` — the directory inside the extracted `.rmdoc` archive that contains the per-page `<uuid>.rm` files (typically named after the document UUID).
- `<out-dir>` — receives `strokes-page1.svg`, `strokes-page2.svg`, … one SVG overlay per annotated page.

Bootstraps a Python venv at `skills/sketch-brainstorm/.venv/` on first run and installs `rmscene` via `requirements.txt`. Subsequent runs reuse the venv.

## Outbound PDF render entry point

From the Ring-O-Meter repo root:

```
bash .claude/skills/sketch-brainstorm/render-html-to-pdf.sh \
  --topic "warmup gate UI" \
  --iteration seed \
  --out .tmp/sketch-brainstorm/test/seed.pdf
```

CLI flags:

- `--topic <string>` (required): substituted into the page header on each rendered page.
- `--iteration <string>` (required): label like `seed`, `iter01`, `iter05`. Substituted into the page header.
- `--out <path>` (required): output PDF path. Parent directory is created if missing.
- `--mockup-html <path>` (optional): file whose contents are substituted into the mockup region. Seed renders pass no mockup; iter renders (a future plan) pass LLM-generated mockup HTML.

Windows: the bash wrapper requires Git Bash or WSL. PowerShell users invoke via `bash render-html-to-pdf.sh ...`.

The wrapper expects to run from a host repo that has `playwright` installed in `web/node_modules/` (the Ring-O-Meter shape). When the skill ships to its own gist, that constraint loosens via a per-skill `package.json` and `npm install` (see README).

## Outbound rmapi push entry point

After rendering a PDF, push it to a folder on the reMarkable cloud:

```
bash .claude/skills/sketch-brainstorm/push-to-tablet.sh \
  --pdf .tmp/sketch-brainstorm/test/seed.pdf \
  --cloud-folder Brainstorms/warmup-gate
```

CLI flags:

- `--pdf <path>` (required): local PDF file to upload.
- `--cloud-folder <path>` (required): reMarkable cloud folder. Created via `rmapi mkdir` if missing (single-level only; deeper paths require their parents to exist).

The wrapper verifies `rmapi` is on PATH and authenticated, runs `rmapi mkdir` (tolerating already-exists), then `rmapi put --force`. The cloud filename equals the source basename and the cloud display strips `.pdf` (see README rmapi quirks). Cloud-path composition (project root + per-session slug) is the bootstrap-dialogue slice's responsibility; this wrapper is intentionally dumb about session structure.

Per-machine setup: `rmapi` must already be installed and paired (the future `setup-rmapi.sh` helper will own first-run pairing). If `rmapi ls` fails, re-pair before invoking the push wrapper.

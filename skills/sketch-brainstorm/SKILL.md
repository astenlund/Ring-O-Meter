---
name: sketch-brainstorm
description: Round-trip UI brainstorm loop with a reMarkable tablet. Use when the user wants to sketch on the tablet ("push to tablet", "send sketch to remarkable", "brainstorm UI on the tablet", "pull from tablet", "grab the annotated version"). Renders HTML mockups to PDF at the tablet's viewport, pushes via rmapi (future slice), polls for annotations, interprets pen marks, iterates.
---

# sketch-brainstorm

A skill for design-iteration with handwritten annotations on a reMarkable tablet. The user sketches reactions on the tablet, Claude reads the marks and emits the next mockup.

## STATUS: render-only walking skeleton

This skill is currently the first vertical slice. Both render directions work locally:

- `render-html-to-pdf.sh` produces a two-page PDF at the Paper Pro viewport from a parametrised HTML template. Page 1 is the mockup page (header, mockup region, small notes area, chrome footer with the Finish-turn checkbox); page 2 is the legend page (header, vocabulary legend, larger notes area, mirrored chrome footer). The user can append further pages on the tablet for long-form notes (handled by the future interpretation slice).
- The PDF can be eyeballed locally.
- `render-strokes.sh` converts per-page `.rm` stroke files (from a locally extracted `.rmdoc` archive) to SVG overlays at the same viewport dimensions as the PDF. Bootstraps a Python venv with `rmscene` on first run.

Not yet implemented (deferred to follow-up plans):

- rmapi cloud push and pull (`setup-rmapi.sh`, `~/.rmapi` token, deny rules, PreToolUse hook, `rmapi get`)
- Bootstrap dialogue (precondition check, topic prompt, cloud path resolution, design-language briefing)
- Background polling script and pixel-region checkbox sentinel (color-aware detection sampled from the pre-render baseline)
- Per-rendered-page interpretation pipeline (pre-render + strokes + annotated composite) feeding a fresh subagent; user-added pages 3+ pass through as additional stroke views
- Multi-sketch iterations (N rendered sketches plus a trailing legend page, for side-by-side alternatives)
- Verify-before-push (visual sanity check on the rendered output before pushing)
- iter01+ loop and `design-state.md` append protocol
- B&W and Wireframe render modes (Color is current default and only mode)
- Vocabulary lifecycle (weight-based active / archived split, frecency-style scoring) and close-session ceremony

When asked to push to the tablet today, surface that the push half is not implemented yet and point at the feature spec for the full design.

## Files in this skill

- `SKILL.md` -- this file.
- `README.md` -- condensed design rationale for the skill.
- `vocabulary.md` -- canonical core vocabulary table (gestures and their meanings).
- `render/page-template.html` -- HTML template with `{{topic}}`, `{{iteration_label}}`, `{{mockup_html}}` tokens.
- `render/page-chrome.css` -- styles for header strip, notes region, legend, and Finish-turn checkbox.
- `render/render.mjs` -- Node ESM script that substitutes tokens, launches Chromium, and writes the PDF.
- `render-html-to-pdf.sh` -- bash wrapper around `render.mjs`. The user-facing entry point.
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

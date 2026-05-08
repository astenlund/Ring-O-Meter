# sketch-brainstorm

A Claude skill that turns a reMarkable tablet into a high-fidelity input channel for UI design iteration.

## Why this exists

UI brainstorming is fundamentally spatial. The default loop is: type a description, Claude writes HTML, screenshot the result, describe changes in text, repeat. Markup is verbose ("the spacing between the second and third row should be tighter and the cancel button should move closer to the primary action") where a single circled arrow on paper would convey the same intent in two seconds.

This skill closes the loop by turning the tablet into the input device:

1. Claude writes HTML and CSS for a mockup, renders it to a PDF at the tablet's viewport.
2. The PDF appears on the tablet via the reMarkable cloud.
3. The user sketches reactions on the tablet (arrows, strokes, handwritten text) using a small visual vocabulary.
4. Claude pulls the annotated PDF, reads the marks via its multimodal Read tool, distills user intent, and emits the next iteration.

Secondary benefit: location independence. UI brainstorming is a common couch / breakfast-table activity that the default loop chains to a laptop. Pushing the mockup to a paper-feeling device unblocks that.

## Status

This is the **render-only walking skeleton**. Only the local PDF render works today; rmapi push, polling, interpretation, and the iter01+ loop are stacked in follow-up slices. See `SKILL.md` for the current entry-point and `STATUS` block.

## Architecture (full design)

The full design is documented in the host project's feature backlog at `.claude/features/remarkable-tablet-brainstorm.md` (private to the Ring-O-Meter repo where this skill is being incubated). Key shape:

- **Transport**: `rmapi` (community CLI for reMarkable Cloud). USB tether is the documented escape hatch.
- **Render**: Playwright drives Chrome via DevTools Protocol; pages target the Paper Pro viewport (1620x2160 px at 229 PPI, 7.08 x 9.43 inches at full bleed). rM2 owners see a small letterboxed margin.
- **Hand-off**: a Finish-turn checkbox at fixed pixel coordinates serves as the deterministic turn-boundary, mirrored on every rendered page so the user can mark Finish-turn from whichever page they are on. A background polling script crops the checkbox region from each pulled PDF and uses color-aware variance detection (sampling the per-iteration pre-render baseline as the source of truth for what each rendered checkbox is supposed to look like) to identify user marks. No multimodal LLM read in the polling loop until a real turn fires.
- **Interpretation**: a fresh subagent per turn receives five image views (page-1 pre-render, page-1 annotated, page-1 diff, page-2 pre-render, page-2 annotated) plus any user-added extra pages plus the design state and vocabulary, returns distilled `user_intent` text. Multimodal raster data never lands in the parent context.
- **Memory**: per-session `design-state.md` head plus an immutable archive chain. Async compression keeps the active head bounded turn-over-turn.
- **Layout contract**: pinned in this skill's render output. The Finish-turn checkbox at coordinates `(1500, 2050)` 80x80 px on the `1620x2160` viewport, in the chrome footer of every rendered page, is load-bearing for the future polling slice's hardcoded crop.

## Per-machine setup

- `rmapi` on `$PATH`. The skill assumes it is installed and authenticated; a `setup-rmapi.sh` helper (future slice) handles initial pairing and token rotation.
- A host project with `playwright` available. Today the skill resolves Playwright from the host repo's `web/node_modules`. When the skill ships to its own gist, this loosens via a per-skill `package.json` and `npm install`.
- Chrome installed on the machine (the render uses `channel: 'chrome'` to mirror the host project's e2e suite).

## Files

- `SKILL.md` -- auto-routing description, current STATUS, render entry-point.
- `vocabulary.md` -- canonical core vocabulary table.
- `render/page-template.html` -- HTML template with token placeholders.
- `render/page-chrome.css` -- chrome-zone styles (header, notes, legend, checkbox).
- `render/render.mjs` -- Node ESM script that drives Chromium and writes the PDF.
- `render-html-to-pdf.sh` -- bash wrapper invoking the render script.

The intended gist layout is a mechanical mirror of this directory tree.

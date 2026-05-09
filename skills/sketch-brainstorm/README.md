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

Both transport directions work end-to-end. **Outbound**: render an HTML mockup to a PDF, push to a folder on the reMarkable cloud via rmapi. **Inbound**: pull a cloud document with `rmapi get`, extract the `.rmdoc` archive, parse the per-page `.rm` files into transparent SVG overlays. What remains: polling + checkbox detection, the interpretation subagent that composites pre-render PDFs with stroke overlays, the iter01+ loop, and `design-state.md`. See `SKILL.md` for current entry-points.

## Architecture (full design)

The full design is documented in the host project's feature backlog at `.claude/features/remarkable-tablet-brainstorm.md` (private to the Ring-O-Meter repo where this skill is being incubated). Key shape:

- **Transport**: `rmapi` (community CLI for reMarkable Cloud). USB tether is the documented escape hatch.
- **Render (outbound)**: Playwright drives Chrome via DevTools Protocol; pages target the Paper Pro viewport (1620x2160 px at 229 PPI, 7.08 x 9.43 inches at full bleed). rM2 owners see a small letterboxed margin.
- **Render (inbound)**: `rmapi get` pulls the turn's `.rmdoc` archive (zip with the source PDF + per-page `.rm` stroke files); `rmscene` parses the `.rm` files into vector stroke data; we render the strokes to SVG overlays at the same viewport dimensions as the rendered PDF. We do NOT use `rmapi geta` (its bundled `.rm` renderer trails the device firmware; recent v6 strokes fail with `Unknown header`). Going through `.rm` files directly gives clean vector data with exact device coordinates, no rasterisation noise, and no diff/subtract step.
- **Hand-off**: a Finish-turn checkbox at fixed pixel coordinates serves as the deterministic turn-boundary, mirrored on every rendered page so the user can mark Finish-turn from whichever page they are on. A background polling script crops the checkbox region from each pulled PDF and uses color-aware variance detection (sampling the per-iteration pre-render baseline as the source of truth for what each rendered checkbox is supposed to look like) to identify user marks. No multimodal LLM read in the polling loop until a real turn fires.
- **Interpretation**: a fresh subagent per turn receives, per page: the pre-render PDF view, the stroke SVG overlay (vector strokes from `rmscene`, replacing the raster-diff approach), and the annotated PDF view; plus any user-added extra pages plus the design state and vocabulary; returns distilled `user_intent` text. Multimodal raster data never lands in the parent context.
- **Memory**: per-session `design-state.md` head plus an immutable archive chain. Async compression keeps the active head bounded turn-over-turn.
- **Layout contract**: pinned in this skill's render output. The Finish-turn checkbox at coordinates `(1540, 2100)` 40x40 px on the `1620x2160` viewport, in the chrome footer of every rendered page, is load-bearing for the future polling slice's hardcoded crop. Sized to leave a 60 px sibling slot above for the future End-session checkbox.

## Open questions

- **Which font to bundle.** Today `page-chrome.css` declares the
  platform system-font stack (`-apple-system, BlinkMacSystemFont,
  "Segoe UI", Roboto, sans-serif`), so the rendered PDF embeds whatever
  the rendering machine resolves. On Windows that is Segoe UI. The
  system stack works because Chrome embeds the actual glyph subsets
  into the PDF at render time, so the device always sees consistent
  glyphs for a given render. But two different rendering machines
  produce two different PDFs, and a future move to e.g. macOS or a
  CI runner would silently shift typography across iterations. Once a
  specific face is chosen, ship it via `@font-face` (likely a co-located
  `.woff2`) so renders are byte-stable across hosts. Pending the user's
  choice.
- **Re-tune the chrome-footer label nudge after font swap.** The
  `.finish-turn-label`'s `top: 2098px` (rather than 2100, where the
  matching checkbox sits) compensates for Segoe UI's particular
  line-box-vs-cap-height geometry. Different fonts have different
  metrics; the nudge will need empirical re-measurement on the new
  face. The value is tagged in `page-chrome.css` with a comment that
  greps for "font-metric" so it is easy to find.

## Per-machine setup

- `rmapi` on `$PATH`. The skill assumes it is installed and authenticated; a `setup-rmapi.sh` helper (future slice) handles initial pairing and token rotation.
- A host project with `playwright` available. Today the skill resolves Playwright from the host repo's `web/node_modules`. When the skill ships to its own gist, this loosens via a per-skill `package.json` and `npm install`.
- Chrome installed on the machine (the render uses `channel: 'chrome'` to mirror the host project's e2e suite).
- Python 3.10+ on `$PATH`. The inbound stroke-rendering pipeline (`render/render-strokes.py`) bootstraps a Python venv on first run inside the skill folder (`./.venv/`) and installs `rmscene` and any rendering helpers from `requirements.txt`. The venv keeps the Python deps self-contained alongside the skill rather than polluting the host machine's global Python.

## rmapi quirks observed in practice

- **`rmapi put <file>` defaults to cloud root.** Passing `/` as the destination explicitly fails with `directory doesn't exist`; rmapi treats `/` as a path lookup, not a root marker. The push wrapper sidesteps the ambiguity by requiring an explicit `--cloud-folder` argument, so "no destination" is never a valid input shape; any future caller that wants a root push must elide the destination entirely rather than pass `/`.
- **`rmapi put` has no `--name` flag.** The cloud filename equals the source basename. To push with a different cloud name, either rename the source file before the call (then restore) or follow the `put` with `rmapi mv <basename> <new-name>` as a second step.
- **The cloud strips `.pdf` in display surfaces.** `rmapi ls` output and the device's file picker show bare names; the PDF identity is preserved at the protocol level. Pass arguments to `rmapi mv` and `rmapi put` as the bare name (no extension) once the file is on the cloud, even though the source file retains `.pdf`.
- **Use `rmapi get`, not `rmapi geta`.** `geta` asks the cloud to render a flattened annotated PDF, which goes through rmapi's bundled `.rm` renderer. That renderer trails the device firmware: as of rmapi 0.0.33 (the latest stable), `.rm` v6 files (written by recent firmware) fail with `Failed to generate annotations: Unknown header`. `rmapi get` returns the raw `.rmdoc` archive (a zip with the source PDF + per-page `.rm` files), which we parse with `rmscene` ourselves. This sidesteps the rmapi-renderer-vs-device-firmware version drift entirely.
- **Per-page `.rm` files are named by random UUID; PDF page order lives in the sibling `<doc-uuid>.content` JSON.** Sorting `.rm` filenames alphabetically scrambles strokes against PDF pages (the very first observed archive happened to sort backwards). The authoritative mapping is `cPages.pages[].redir.value` (0-based PDF page index) inside the `.content` file; `render-strokes.py` reads it and falls back to alphabetical sort with a warning if the file is missing. Treat the `.content` field as load-bearing for inbound page ordering, not a diagnostic.
- **`rmapi rm -r <folder>` orphans contained files to the cloud root rather than deleting them.** Verified on rmapi 0.0.33: a folder containing one PDF, after `rmapi rm -r`, leaves the folder gone and the PDF reappearing at the cloud root with the same bare name. The cleanup pattern is therefore "delete leaves first, folders last", not the POSIX-shaped "rm -rf the parent". Future session-cleanup or close-session ceremony slices must enumerate contents via `rmapi ls <folder>` and `rmapi rm` each leaf before removing the folder. Any `--purge` style helper should pattern-match this two-phase order.
- **`rmapi mkdir` is single-level only; no `--parents` flag.** Matches the BSD `mkdir` shape, not GNU `mkdir -p`. Multi-segment cloud paths must be created one level at a time. The push wrapper assumes parents already exist; deeper cloud-tree provisioning belongs to the bootstrap-dialogue slice.
- **`rmapi get` writes to PWD with no `-o`/`--output` flag, and silently overwrites an existing `<basename>.rmdoc`.** No way to direct the output via a flag; callers `cd` into the destination directory before invoking. The silent-overwrite behavior is friendly for re-pulls during iteration (no stale-file collision) but means a wrapper cannot detect a stale archive without checksumming. Missing-doc error wording on rmapi 0.0.33: `file doesn't exist` (with an `Error:` prefix and a `main.go:NN` source-line stamp; the stable substring is `file doesn't exist`).
- **`rmapi get` writes its `downloading: ... OK` progress to stdout, not stderr.** Any wrapper that emits a pipe-friendly stdout line (e.g., the extracted directory path) must redirect rmapi's stdout to stderr (`rmapi get ... >&2`) or its progress will contaminate the captured output.
- **`.rmdoc` archive shape varies between un-annotated and annotated docs.** Un-annotated cloud docs (newly pushed, never opened on the device): a flat archive with `<doc-uuid>.content`, `<doc-uuid>.metadata`, `<doc-uuid>.pdf` at archive root and no `.rm` files. Once the user opens the doc and annotates, the archive grows a nested `<doc-uuid>/` subdirectory containing the per-page `<page-uuid>.rm` stroke files, and a `<doc-uuid>.pagedata` file appears alongside the manifest at root. `pull-from-tablet.sh` detects the nested subdirectory and emits its path as the rm-dir; un-annotated pulls emit the outer extract dir, which `render-strokes.py` correctly reports as containing zero strokes. The `.content` schema also evolves with the doc lifecycle: un-opened docs use the older format with `pageCount: 0`, `pages: null`, no `cPages`; opened docs use `cPages.pages[].redir.value` per the inbound page-ordering contract.

## Files

- `SKILL.md` -- auto-routing description, current STATUS, render entry-point.
- `vocabulary.md` -- canonical core vocabulary table.
- `render/page-template.html` -- HTML template with token placeholders.
- `render/page-chrome.css` -- chrome-zone styles (header, notes, legend, checkbox).
- `render/render.mjs` -- Node ESM script that drives Chromium and writes the PDF.
- `render-html-to-pdf.sh` -- bash wrapper for the outbound PDF render pipeline.
- `push-to-tablet.sh` -- bash wrapper for the rmapi push (outbound cloud upload).
- `pull-from-tablet.sh` -- bash wrapper for `rmapi get` + `.rmdoc` extraction (inbound cloud download).
- `_lib.sh` -- internal bash helpers sourced by the transport wrappers (rmapi auth precondition).
- `render/render-strokes.py` -- converts per-page `.rm` stroke files to SVG overlays.
- `render-strokes.sh` -- bash wrapper for the inbound stroke-rendering pipeline.
- `requirements.txt` -- Python deps for the inbound pipeline (rmscene).

The intended gist layout is a mechanical mirror of this directory tree.

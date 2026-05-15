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

Both transport directions work end-to-end and the full interpretation pipeline (strokes -> composite -> multimodal subagent -> structured JSON) is functionally validated. **Outbound**: render an HTML mockup to a PDF, push to a folder on the reMarkable cloud via rmapi. **Inbound**: pull a cloud document with `rmapi get`, extract the `.rmdoc` archive, parse the per-page `.rm` files into transparent SVG overlays, composite each overlay onto its source PDF page, dispatch a fresh subagent with the composite PNGs + the vocabulary, receive a structured JSON block with `user_intent`, `design_state_delta`, and `per_page_observations`. The iter01+ loop that consumes `user_intent` to drive the next render, `design-state.md` for cross-turn memory, and bootstrap-lite (the minimum viable preamble that gets iter 00 onto the tablet) all ship today. The stroke-region checkbox detector and one-time calibration ceremony also ship today: `derive-calibration.sh` runs the five-dot ceremony to produce a firmware-versioned `calibration.json`, and `detect-marks.sh` per-turn emits structured JSON describing the marked state of each chrome checkbox (Finish-turn, End-session, and the mode-switch trio) across all pages via a capsule-area-threshold mark detector (stroke width times clipped centerline length), which handles both snap-to-straight chords and thick-marker single taps. Background polling now wraps the detector: `poll-tablet.sh` spawns as a backgrounded process, uses `rmapi stat` (Version + ModifiedClient) to short-circuit idle iterations, pulls + detects only on cloud-side change, and emits `READY:<NN>` on stdout (with a `mode=<color|bw|wireframe>` suffix when the user flipped the radio-button mode-switch trio) or `STOP:<NN>` when End-session is marked. The poller exits after one READY/STOP; the orchestrator respawns it with the next iter's `--cloud-doc` after pushing. The active mode is pre-filled into its checkbox at render time (chrome gold #a08020) and threaded across turns via `current_mode` in `design-state.md`'s frontmatter; B&W and Wireframe modes are wired as mode-specific stylesheets injected by render.mjs. `write-design-state.sh` performs the atomic per-turn frontmatter-update + iter-section replace-or-append + temp-write + rename, and `read-prefill.sh` provides cross-machine resume by pixel-sampling the cloud PDF's pre-filled mode-switch box to recover `current_mode` when local state is missing. Verify-before-push wraps the post-render / pre-push step: `verify-prompt.md` is the prompt template the orchestrator substitutes (`{NEW_PRERENDER_PATHS}`, `{PRIOR_PRERENDER_PATHS}` (literal `none` on iter 00 or when no prior pre-renders exist), `{USER_INTENT}`), `parse-verify-response.mjs` validates the subagent's `{verdict, reason}` JSON block (PASS implies empty reason, FAIL implies non-empty; unknown fields tolerated for forward compat), and on FAIL the orchestrator regenerates and re-renders up to 2 times before pushing anyway and surfacing the verifier's last reason in chat. What remains: the full bootstrap dialogue (design-language briefing, lock-file check, resume-vs-fresh history list), ERROR taxonomy with exponential backoff for transient rmapi failures, the auth bootstrap (`setup-rmapi.sh`), and compression (turn-by-turn rotation of design-state.md sections into archives). See `SKILL.md` for current entry-points.

## Architecture (full design)

The full design is documented in the host project's feature backlog at `.claude/features/remarkable-tablet-brainstorm.md` (private to the Ring-O-Meter repo where this skill is being incubated). Key shape:

- **Transport**: `rmapi` (community CLI for reMarkable Cloud). USB tether is the documented escape hatch.
- **Render (outbound)**: Playwright drives Chrome via DevTools Protocol; pages target the Paper Pro viewport (1620x2160 px at 229 PPI, 7.08 x 9.43 inches at full bleed). rM2 owners see a small letterboxed margin.
- **Render (inbound)**: `rmapi get` pulls the turn's `.rmdoc` archive (zip with the source PDF + per-page `.rm` stroke files); `rmscene` parses the `.rm` files into vector stroke data; we render the strokes to SVG overlays at the same viewport dimensions as the rendered PDF. We do NOT use `rmapi geta` (its bundled `.rm` renderer trails the device firmware; recent v6 strokes fail with `Unknown header`). Going through `.rm` files directly gives clean vector data with exact device coordinates, no rasterisation noise, and no diff/subtract step.
- **Hand-off**: a fixed-position chrome footer on every rendered page hosts five checkboxes: Finish-turn (turn-boundary), End-session (session-boundary), and a Color / B&W / Wireframe mode-switch trio. A stroke-region detector (`detect-marks.sh`) inverse-transforms each registered checkbox's PDF rectangle into `.rm` coordinates using a firmware-versioned scale from `calibration.json`, then evaluates a capsule-area threshold (stroke width times clipped centerline length intersected with the box) to decide marked vs not, and emits a nested JSON `boxes` map per page keyed by box name with `area_rm_sq` + `marked`. The one-time calibration ceremony (`derive-calibration.sh`) pins the scale by asking the user to mark five reference dots. The polling wrapper (`poll-tablet.sh`) spawns as a backgrounded process via `Bash(run_in_background=true)`, watches the current iter's cloud doc via `rmapi stat`, pulls + detects on change, applies winner-takes-all to the mode-switch trio, and emits `READY:<NN>` (optionally with a `mode=<X>` suffix) or `STOP:<NN>` on stdout. The poller exits after one READY/STOP; the orchestrator respawns with the next iter's `--cloud-doc` after pushing.
- **Interpretation**: a fresh subagent per turn receives, per page: the pre-render PDF view, the stroke SVG overlay (vector strokes from `rmscene`, replacing the raster-diff approach), and the annotated PDF view; plus any user-added extra pages plus the design state and vocabulary; returns a fenced JSON block with three fields: `user_intent` (1-3 sentence summary that drives the next-render compose), `design_state_delta` (markdown body to append under `## Iteration NN` in `design-state.md`), and `per_page_observations` (per-annotated-page observation strings, surfaced to chat for visibility then discarded). Multimodal raster data never lands in the parent context. The orchestrator pipes the response through `parse-interpret-json.mjs` for validation; that file's docblock is the authoritative schema.
- **Memory**: per-session `design-state.md` head plus an immutable archive chain. Async compression keeps the active head bounded turn-over-turn.
- **Layout contract**: pinned in `page-chrome.css` and `detect_marks.py`'s per-box PDF rectangles. The chrome footer of every rendered page on the `1620x2160` viewport hosts Finish-turn at `(1540, 2100)`, End-session at `(1540, 2040)`, and the mode-switch trio (Color / B&W / Wireframe) at x=80/240/400 y=2100, all 40x40 px. Coordinates must not move without re-running the calibration ceremony and updating the constants in lockstep (both files carry cross-reference comments).

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
- `render/page-chrome.css` -- chrome-zone styles (header, notes, legend, checkboxes).
- `render/page-chrome-bw.css` -- B&W mode stylesheet, injected by render.mjs when `--current-mode bw`.
- `render/page-chrome-wireframe.css` -- Wireframe mode stylesheet, injected by render.mjs when `--current-mode wireframe`.
- `render/render.mjs` -- Node ESM script that drives Chromium and writes the PDF.
- `render-html-to-pdf.sh` -- bash wrapper for the outbound PDF render pipeline.
- `push-to-tablet.sh` -- bash wrapper for the rmapi push (outbound cloud upload).
- `pull-from-tablet.sh` -- bash wrapper for `rmapi get` + `.rmdoc` extraction (inbound cloud download).
- `poll-tablet.sh` -- bash wrapper for the background polling daemon; emits `READY:<NN>` (optionally with `mode=<X>` suffix) or `STOP:<NN>` on stdout.
- `render/poll_tablet.py` -- polling daemon implementation; lock file with heartbeat, `rmapi stat`-driven change detection, detector dispatch.
- `render/test_poll_tablet.py` -- unit tests for the poller (stdlib-only, no venv needed).
- `detect-marks.sh` -- bash wrapper for the per-turn checkbox detector; emits structured JSON keyed by box name.
- `render/detect_marks.py` -- capsule-area mark detector; reports per-box `area_rm_sq` + `marked` across all pages.
- `render/_chrome_boxes.py` -- dependency-free shared data module: BOX_REGISTRY (5-box PDF coordinates), VALID_MODES, ITER_NN_RE. Importable from both venvs.
- `render/_geometry.py` -- capsule-area geometry primitives; stdlib-only (math only). Extracted so test_geometry.py runs without the venv.
- `render/_atomic_write.py` -- atomic_write_text helper (write-to-temp + os.replace); shared by poll_tablet and write_design_state.
- `render/_rm_strokes.py` -- shared .rm parser: PAGE_W/PAGE_H, PEN_COLORS, collect_lines, ordered_rm_files, CALIBRATION_JSON, CALIBRATION_SCHEMA_VERSION, CalibrationError, load_calibration.
- `render/test_detect_marks.py` -- unit tests for the detector (stdlib-only with rmscene stubbed).
- `render/test_geometry.py` -- unit tests for capsule-area geometry helpers; stdlib-only (imports _geometry.py directly; no venv or rmscene stub required).
- `write-design-state.sh` -- bash wrapper for the atomic design-state.md update (frontmatter + iter-section replace-or-append + write-temp + rename).
- `render/write_design_state.py` -- implementation of the atomic write helper; includes a pre-write integrity check that rejects pre-existing duplicate `## Iteration NN` headings (silent-corruption guard for external file mutation).
- `render/test_write_design_state.py` -- unit tests for write-design-state (stdlib-only).
- `read-prefill.sh` -- bash wrapper for the cross-machine resume helper; pixel-samples the cloud PDF's pre-filled mode-switch box and prints the active mode.
- `render/read_prefill.py` -- implementation of read-prefill (venv-required: PyMuPDF + Pillow).
- `render/test_read_prefill.py` -- unit tests for read-prefill (venv-required).
- `test.sh` -- bash wrapper that runs the Python test suite (via the skill venv) followed by the Node test suite (`test_*.mjs`). `bash test.sh` runs both; pass `test_<module>` or a dotted test id to target a Python subset.
- `_lib.sh` -- internal bash helpers sourced by other wrappers: rmapi auth precondition, shared Python venv bootstrap with requirements.txt drift detection, and `find_repo_root <start-dir>` (walk-upward `Ring-O-Meter.slnx` marker discovery; sourced by `render-html-to-pdf.sh` with `$SCRIPT_DIR` and by `bootstrap-session.sh` with `$PWD`).
- `render/render-strokes.py` -- converts per-page `.rm` stroke files to SVG overlays.
- `render-strokes.sh` -- bash wrapper for the inbound stroke-rendering pipeline.
- `render/composite-annotated.py` -- composites stroke SVGs onto PDF pages as PNGs (uses PyMuPDF + Pillow).
- `composite-annotated.sh` -- bash wrapper for the composite step.
- `render/prerender-pages.py` -- PyMuPDF-based PDF-to-PNG rasterizer; invoked by `render-html-to-pdf.sh`'s `--prerender-out` flag.
- `bootstrap-session.sh` -- creates the per-session local folder skeleton and primes `design-state.md` (including `current_mode: color` frontmatter); idempotent.
- `parse-interpret-json.mjs` -- shell-callable JSON parse + validate helper for the interpret subagent's response.
- `parse-verify-response.mjs` -- shell-callable JSON parse + validate helper for the verify subagent's response (`{verdict, reason}` with asymmetric-reason rule + forward-compat unknown-field tolerance).
- `render/test_composite_annotated.py` -- unit tests covering: page-pattern regex and numeric sort (`composite-annotated.py`); resolution-constants invariant across the three python modules; `collect_lines` single-point-stroke contract (`_rm_strokes.py`); `main()` calibration-present and auto-fit branches (`render-strokes.py`).
- `render/test_prerender_pages.py` -- end-to-end test for `prerender-pages.py` against a real two-page PDF.
- `render/test_render_format.mjs` -- node:test cases for `formatIterationLabel`.
- `test_interpret_parse.mjs` -- node:test cases for `parseInterpretResponse`.
- `test_verify_parse.mjs` -- node:test cases for `parseVerifyResponse` (12 cases including PASS/FAIL happy paths, the asymmetric-reason rule both directions, CRLF, chatty preamble, no-fence, malformed JSON, missing fields, wrong-cased verdict, unknown-field tolerance).
- `test_bootstrap_session.sh` -- bash test for `bootstrap-session.sh`.
- `interpret-prompt.md` -- prompt template for the interpretation subagent. Read by the orchestrator (Claude in main chat); not directly executable.
- `verify-prompt.md` -- prompt template for the verify-before-push subagent. Read by the orchestrator; substituted tokens are the new + prior pre-render PNG paths plus the turn's `user_intent`.
- `requirements.txt` -- Python deps for the inbound pipeline (rmscene + pymupdf + Pillow).

The intended gist layout is a mechanical mirror of this directory tree.

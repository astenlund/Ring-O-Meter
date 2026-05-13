---
name: sketch-brainstorm
description: Round-trip UI brainstorm loop with a reMarkable tablet. Use when the user wants to sketch on the tablet ("push to tablet", "send sketch to remarkable", "brainstorm UI on the tablet", "pull from tablet", "grab the annotated version"). Renders HTML mockups to PDF at the tablet's viewport, pushes to the reMarkable cloud via rmapi, drives an iter-by-iter render-pull-interpret-render loop. Polling, full bootstrap dialogue, verify-before-push, and compression are deferred to follow-up slices.
---

# sketch-brainstorm

A skill for design-iteration with handwritten annotations on a reMarkable tablet. The user sketches reactions on the tablet, Claude reads the marks and emits the next mockup.

## STATUS: closed loop + stroke-region detector + calibration ceremony

Round-trip ships end-to-end and the stroke-region Finish-turn detector
+ one-time calibration ceremony are in place. Polling, full bootstrap
dialogue, verify-before-push, compression, and multi-sketch are still
deferred to follow-up slices.

- `render-html-to-pdf.sh` produces a two-page PDF at the Paper Pro viewport from a parametrised HTML template. Page 1 is the mockup page (header, mockup region, small notes area, chrome footer with the Finish-turn checkbox); page 2 is the legend page (header, vocabulary legend, larger notes area, mirrored chrome footer). The user can append further pages on the tablet for long-form notes (handled by the future interpretation slice). `--subtopic` (forward-compat for multi-sketch) and `--prerender-out <dir>` (captures per-page PNGs to feed verify-before-push when it lands).
- `push-to-tablet.sh` uploads a rendered PDF to a named cloud folder via `rmapi put --force`. Owns just the upload step; cloud-path composition (project root + per-session slug) belongs to the future bootstrap-dialogue slice that calls this wrapper.
- `pull-from-tablet.sh` downloads a cloud document via `rmapi get` and extracts the resulting `.rmdoc` archive into a per-document directory. Stdout is the extracted directory path so it pipes directly into `render-strokes.sh`. Owns just the download + extract; rendering and interpretation are downstream.
- `render-strokes.sh` converts per-page `.rm` stroke files (in the directory `pull-from-tablet.sh` produces, or any locally-extracted `.rmdoc`) to SVG overlays at the same viewport dimensions as the PDF. Bootstraps a Python venv with `rmscene` on first run.
- `composite-annotated.sh` overlays each `strokes-pageN.svg` onto its matching PDF page at full Paper Pro resolution and writes `composite-pageN.png`. Uses the same shared venv as `render-strokes.sh` (PyMuPDF for both PDF and SVG rasterization, Pillow for the alpha-composite). The PNGs are what the interpretation subagent reads multimodally.
- `interpret-prompt.md` is the prompt template for the interpretation subagent. The orchestrator (Claude in main chat) substitutes tokens (composite paths, vocabulary path, session topic) and dispatches via the Agent tool with `subagent_type: general-purpose`. The fresh subagent reads the composite PNGs + the vocabulary itself, identifies stroke clusters, attributes them to UI elements, consults the vocabulary, and returns a fenced JSON block with `user_intent`, `design_state_delta`, and `per_page_observations` per the contract documented at the top of `interpret-prompt.md`. Multimodal raster data lives only in the subagent's context; the orchestrator receives only the distilled text.
- `bootstrap-session.sh` -- creates the per-session local folder
  skeleton (`mockups/`, `prerender/`, `pulls/`, `strokes/`,
  `composites/`, `archive/`) and primes `design-state.md` with
  frontmatter and a `## Iteration 00` section. Idempotent.
- `parse-interpret-json.mjs` -- shell-callable helper that extracts
  and validates the JSON block from an interpret subagent's response.
  Used by the loop body's parse step; tested at
  `test_interpret_parse.mjs`.
- `render/prerender-pages.py` -- rasterizes each page of a rendered
  PDF to PNG via PyMuPDF, invoked by `render-html-to-pdf.sh`'s
  `--prerender-out` flag.

Not yet implemented (deferred to follow-up plans):

- Auth bootstrap (`setup-rmapi.sh`, `~/.rmapi` token, deny rules, PreToolUse hook); both transport wrappers assume the machine is already paired
- Bootstrap dialogue (precondition check, topic prompt, cloud path resolution, design-language briefing)
- Stroke-region checkbox detector calibration ceremony (`derive-calibration.py`, 5-dot PDF, `calibration.json`) and detector script (`detect-marks.sh`); background polling script wrapping the detector with the stdout `READY:NN` protocol
- Multi-sketch iterations (N rendered sketches plus a trailing legend page, for side-by-side alternatives)
- Verify-before-push (visual sanity check on the rendered output before pushing)
- B&W and Wireframe render modes (Color is current default and only mode)
- Vocabulary lifecycle (weight-based active / archived split, frecency-style scoring) and close-session ceremony

The automated loop ships today: bootstrap-lite + iter01+ render loop +
structured interpret JSON. Polling and the full bootstrap dialogue are
deferred to follow-up slices, so the orchestrator drives the loop via
manual chat triggers (`go` / `pull` / `next` / `iter NN`) rather than
auto-detecting the user's tablet back-out.

## Files in this skill

- `SKILL.md` -- this file.
- `README.md` -- condensed design rationale for the skill.
- `vocabulary.md` -- canonical core vocabulary table (gestures and their meanings).
- `render/page-template.html` -- HTML template with `{{topic}}`, `{{iteration_label}}`, `{{mockup_html}}` tokens.
- `render/page-chrome.css` -- styles for header strip, notes region, legend, and Finish-turn checkbox.
- `render/render.mjs` -- Node ESM script that substitutes tokens, launches Chromium, and writes the PDF.
- `render-html-to-pdf.sh` -- bash wrapper around `render.mjs`. Outbound render entry point.
- `push-to-tablet.sh` -- bash wrapper for `rmapi put`; outbound cloud upload entry point.
- `pull-from-tablet.sh` -- bash wrapper for `rmapi get` + `.rmdoc` extraction; inbound cloud download entry point.
- `_lib.sh` -- internal helpers sourced by other wrappers (rmapi auth precondition; shared Python venv bootstrap with requirements.txt drift detection).
- `render/render-strokes.py` -- converts per-page `.rm` stroke files to SVG overlays.
- `render-strokes.sh` -- bash wrapper for the inbound stroke pipeline; reuses the shared venv.
- `render/composite-annotated.py` -- composites stroke SVGs onto PDF pages as PNGs (PyMuPDF + Pillow).
- `composite-annotated.sh` -- bash wrapper for the composite step; reuses the shared venv.
- `render/prerender-pages.py` -- PyMuPDF-based PDF-to-PNG rasterizer; invoked by `render-html-to-pdf.sh`'s `--prerender-out` flag to feed the deferred verify-before-push slice.
- `bootstrap-session.sh` -- creates the per-session local folder skeleton and primes `design-state.md` with frontmatter + `## Iteration 00`. Idempotent.
- `parse-interpret-json.mjs` -- shell-callable JSON parse + validate helper for the interpret subagent's response. Authoritative schema lives at the top of this file.
- `derive-calibration.sh` -- bash wrapper for the one-time calibration ceremony; runs derive_calibration.py against a pulled five-dot calibration rm-dir to produce calibration.json.
- `render/derive_calibration.py` -- calibration derivation: five-centroid Hungarian assignment, median scale derivation, asymmetry + residual verification, writes calibration.json.
- `detect-marks.sh` -- bash wrapper for the per-turn detector.
- `render/detect_marks.py` -- stroke-region detector: reads calibration.json, inverse-transforms each registered checkbox PDF rectangle to .rm coordinates, hit-tests strokes, emits structured JSON keyed by box name (finish_turn, end_session, mode_color, mode_bw, mode_wireframe).
- `render/_rm_strokes.py` -- shared .rm parser (PAGE_W/PAGE_H constants, PEN_COLORS, collect_lines, ordered_rm_files). Single source of truth for the .rm coordinate system.
- `calibration.json` -- committed at the skill root; firmware-versioned scale produced by the calibration ceremony. Refreshed only when firmware changes invalidate the constant.
- `test-fixtures/calibration-paper-pro-fw<version>.rmdoc` -- captured reference .rmdoc from the calibration ceremony; consumed by test_derive_calibration.py's fixture smoke test.
- `render/test_detect_marks.py` -- JSON-shape test for the detector (stubs rmscene; runs stdlib-only).
- `render/test_derive_calibration.py` -- fixture smoke test for the calibration derivation (uses the committed .rmdoc + the venv).
- `interpret-prompt.md` -- prompt template for the interpretation subagent (read by the orchestrator; not directly executable).
- `test_interpret_parse.mjs` -- node:test cases for `parseInterpretResponse` (happy path, CRLF, missing/wrong-type fields, malformed JSON).
- `test_bootstrap_session.sh` -- bash test for `bootstrap-session.sh` (folder skeleton, frontmatter, idempotency re-run, negative-input rejection).
- `render/test_render_format.mjs` -- node:test cases for `formatIterationLabel`.
- `render/test_prerender_pages.py` -- end-to-end test for `prerender-pages.py` against a real two-page PDF.
- `render/test_composite_annotated.py` -- unit tests for `composite-annotated.py`'s page-pattern regex, numeric sort, and resolution constants (now also cross-checks `prerender-pages.py`).
- `requirements.txt` -- Python deps for the inbound pipeline (rmscene + pymupdf + Pillow).

## Inbound stroke render entry point

After pulling an annotated `.rmdoc` archive with `rmapi get` and extracting it:

```
bash .claude/skills/sketch-brainstorm/render-strokes.sh \
  <rm-dir> \
  .tmp/sketch-brainstorm/test/strokes-out/
```

- `<rm-dir>` - the directory inside the extracted `.rmdoc` archive that contains the per-page `<uuid>.rm` files (typically named after the document UUID).
- `<out-dir>` - receives `strokes-page1.svg`, `strokes-page2.svg`, ... one SVG overlay per annotated page.

Bootstraps a Python venv at `skills/sketch-brainstorm/.venv/` on first run and installs `rmscene` via `requirements.txt`. Subsequent runs reuse the venv.

## Outbound PDF render entry point

From the Ring-O-Meter repo root:

```
bash .claude/skills/sketch-brainstorm/render-html-to-pdf.sh \
  --topic "warmup gate UI" \
  --iteration 00 \
  --out .tmp/sketch-brainstorm/test/warmup-gate-00.pdf
```

CLI flags:

- `--topic <string>` (required): substituted into the page header on each rendered page.
- `--iteration <string>` (required): two-digit zero-padded number (00, 01, 02, ...). The seed render uses 00; subsequent loop-body iterations increment. Substituted into the page header as `<topic> #NN`.
- `--out <path>` (required): output PDF path, conventionally `<slug>-NN.pdf`. Parent directory is created if missing.
- `--mockup-html <path>` (optional): file whose contents are substituted into the mockup region. Iter 00 renders may pass an empty mockup or a description-driven mockup, depending on the bootstrap-lite path; iter 01+ pass orchestrator-composed mockup HTML derived from the prior turn's `user_intent`.
- `--subtopic <string>` (optional): forward-compat hook for the deferred multi-sketch slice; substituted into the page header alongside the topic when present.
- `--prerender-out <dir>` (optional): captures per-page PNGs of the rendered PDF (`<slug>-NN-page1.png`, `-page2.png`, ...) via PyMuPDF; consumed by the deferred verify-before-push slice and useful for spot-checking what was pushed.

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

## Inbound rmapi pull entry point

After the user annotates and backs out to the file picker (which flushes the strokes to the cloud), pull the annotated archive and extract it:

```
bash .claude/skills/sketch-brainstorm/pull-from-tablet.sh \
  --cloud-doc Brainstorms/warmup-gate/iter01 \
  --out-dir .tmp/sketch-brainstorm/pulls/
```

CLI flags:

- `--cloud-doc <path>` (required): cloud document path. Use bare names (no `.pdf`) per the README rmapi quirks; the cloud strips the extension on display.
- `--out-dir <dir>` (required): local directory for the `.rmdoc` archive and its extracted contents. Created if missing.

The wrapper writes `<out-dir>/<basename>.rmdoc` (the raw archive, kept for audit / re-extraction / future polling-diff) and extracts into `<out-dir>/<basename>/`. The shape inside that extract dir depends on whether the doc has been opened on the device: un-annotated docs lay flat (`<doc-uuid>.{content,metadata,pdf}` at the extract-dir root, no `.rm` files); annotated docs are hybrid (the same manifest files at root, plus a nested `<doc-uuid>/` subdirectory containing the per-page `<page-uuid>.rm` stroke files). Stdout is the **rm-dir path**: the inner `<doc-uuid>/` subdirectory when present, the outer extract dir when not. Either way the path composes directly into `render-strokes.sh`:

```
STROKES_DIR="$(bash .claude/skills/sketch-brainstorm/pull-from-tablet.sh \
  --cloud-doc Brainstorms/warmup-gate/iter01 \
  --out-dir .tmp/sketch-brainstorm/pulls/)"
bash .claude/skills/sketch-brainstorm/render-strokes.sh \
  "$STROKES_DIR" .tmp/sketch-brainstorm/pulls/iter01-svgs/
```

The captured stdout is exactly the rm-dir path. rmapi's `downloading: ... OK` progress and any error output stay on stderr (i.e., visible on the terminal alongside the next command's output).

Re-pulling the same `--cloud-doc` overwrites both the archive and the extraction; brainstorm iteration assumes overwrite semantics. Any caller that needs to keep the previous extraction must rename it before re-pulling. `--out-dir` is keyed only on the cloud-doc's leaf basename, so distinct cloud paths sharing a basename (`Foo/iter01` vs `Bar/iter01`) clobber each other when pulled into the same `--out-dir`; use distinct out-dirs to keep both.

Per-machine setup: same as push (`rmapi` paired). Additionally, `python` must be on PATH for the stdlib `zipfile` extraction (this wrapper does not require the `render-strokes.sh` venv; it uses Python only for unzipping).

## Composite entry point

After `render-strokes.sh` produces stroke SVGs, composite them onto the source PDF pages to get the multimodal-readable annotated PNGs:

```
bash .claude/skills/sketch-brainstorm/composite-annotated.sh \
  --pdf .tmp/sketch-brainstorm/pulls/iter01/<doc-uuid>.pdf \
  --strokes-dir .tmp/sketch-brainstorm/pulls/iter01-svgs/ \
  --out-dir .tmp/sketch-brainstorm/pulls/iter01-composites/
```

CLI flags:

- `--pdf <path>` (required): the source PDF. For pulls done via `pull-from-tablet.sh`, this is `<extract-dir>/<doc-uuid>.pdf` (the manifest sits one level above the rm-dir; see README rmapi quirks).
- `--strokes-dir <dir>` (required): directory containing `strokes-pageN.svg` files from `render-strokes.sh`.
- `--out-dir <dir>` (required): receives `composite-pageN.png`. Created if missing.

For each `strokes-pageN.svg` present in the strokes-dir, the wrapper writes one `composite-pageN.png` showing the rendered mockup at full Paper Pro resolution (1620x2160) with the user's strokes overlaid in their original colors at their original positions. Pages without strokes are skipped silently because the interpretation subagent only needs to read pages that carry user annotations.

Per-machine setup: same as `render-strokes.sh` (the two wrappers share the venv). First run on a machine without the venv bootstraps automatically; later runs detect requirements.txt drift via the sentinel hash and rebootstrap if a dep changed.

## Calibration ceremony

A one-time per-firmware ritual that pins the `.rm`-to-PDF scale constant in `calibration.json`. Triggered by user phrases like "calibrate the detector", "recalibrate", or "run calibration".

Flow:

1. Render the calibration PDF from `render/calibration-template.html` (single page, no chrome, five reference dots).
2. Push to the cloud via `push-to-tablet.sh` (under `<project-cloud-path>/_calibration/` if configured, otherwise ask the user where to push).
3. Tell the user: *"Calibration sheet pushed. Mark each dot with a short pen stroke (one stroke per dot), then back out to the file picker and say `done`."*
4. After `done`, pull via `pull-from-tablet.sh`.
5. Run `derive-calibration.sh <rm-dir> <firmware-note> calibration.json`. On rejection, the orchestrator surfaces the diagnostic AND a clear-page retry instruction (tap the three-dot toolbar menu, select "Clear page", re-mark, retry).
6. On success, commit `calibration.json` and the captured `.rmdoc` as `test-fixtures/calibration-paper-pro-fw<version>.rmdoc`.
7. Remove the cloud calibration doc via `rmapi rm`.

The full algorithm (count guard, Hungarian assignment, median scale derivation, 2% asymmetry gate, 3 px residual verification) is documented in the feature spec at `.claude/features/remarkable-tablet-brainstorm.md`.

## Detect entry point

After pulling an annotated `.rmdoc` archive with `pull-from-tablet.sh` and extracting it, check which chrome checkboxes the user marked:

```
bash skills/sketch-brainstorm/detect-marks.sh <rm-dir>
```

`<rm-dir>` is the directory inside the extracted `.rmdoc` archive that contains the per-page `<uuid>.rm` files (typically the directory named after the document UUID). The wrapper bootstraps the shared venv on first run.

Output: a single JSON line on stdout, exit 0 on a clean run regardless of result. JSON shape:

```
{"marked":true,"per_page":[{"page":1,"marked":false,"hit_strokes":0,"total_strokes":4},{"page":2,"marked":true,"hit_strokes":1,"total_strokes":2}]}
```

`marked` is the OR across pages (mirrored-box behaviour). `per_page` always covers every rendered page (length comes from the `.content` manifest's `cPages.pages[]`, not from `.rm` file presence); pages with no `.rm` file get synthesized entries with `hit_strokes:0, total_strokes:0`.

Exit non-zero is reserved for script errors: missing `calibration.json`, malformed rm-dir, unreadable `.content` manifest, rmscene exception. A clean "no marks detected" still exits 0 with `"marked":false`.

Per-machine setup: same as `render-strokes.sh` (Python + the shared venv; bootstrapped on first wrapper invocation).

## Interpretation entry point

After `composite-annotated.sh` produces the composite PNGs, dispatch a fresh interpretation subagent with the assembled prompt:

1. Read `skills/sketch-brainstorm/interpret-prompt.md` (the prompt template).
2. Substitute the bracketed tokens:
   - `{COMPOSITE_PATHS}` - newline-bullet absolute paths to the composite PNGs.
   - `{VOCAB_PATH}` - absolute path to `skills/sketch-brainstorm/vocabulary.md` (and the project-local extension at `.claude/sketch-brainstorm-vocab.md` if it exists).
   - `{TOPIC}` - the session's topic phrase.
3. Dispatch via the Agent tool with `subagent_type: general-purpose`. Pass the substituted prompt body.
4. Receive the subagent's response. Parse the fenced JSON block via `node skills/sketch-brainstorm/parse-interpret-json.mjs` (stdin = raw response; stdout = canonicalized JSON; exit 0 on valid). The parsed object has three fields: `user_intent` (1-3 sentence summary that drives the next-render composition), `design_state_delta` (markdown body to append under `## Iteration NN` in `design-state.md`), and `per_page_observations` (informational; surface to chat for visibility, then discard).

This step is orchestrator-side, not a shell wrapper: the Agent tool is Claude Code's; shells can't dispatch it. The fresh-per-turn discipline is load-bearing - it isolates multimodal raster data to the subagent and keeps the orchestrator context lean across many iterations.

The structured JSON contract documented above is the shipped shape; `parse-interpret-json.mjs` validates it on every loop body iteration. See the Loop body section below for the full orchestrator-side flow, and `interpret-prompt.md`'s "Future expansion" section for fields under consideration but not yet shipped (e.g., `slug_suggestion`).

## Loop body (orchestrator-driven)

When the user signals progress on the active session - `go`, `pull`,
`next`, `iter NN`, or any equivalent unambiguous trigger - run one loop
body iteration:

1. Resolve next iter NN: list the cloud session folder
   (`rmapi ls <cloud-path>/<slug>` exit-status + parse) and take
   `largest <slug>-NN.pdf` + 1.
2. `pull-from-tablet.sh` -> `render-strokes.sh` -> `composite-annotated.sh`
   for iter (NN-1).
3. Dispatch the interpret subagent with the composite PNGs, current
   `design-state.md`, prior `mockups/<slug>-(NN-1).html`, and
   `vocabulary.md`. Collect the response.
4. Pipe the response through `node parse-interpret-json.mjs` (stdin =
   raw response; stdout = canonicalized JSON; exit 0 on valid). On
   parse failure, retry once with a "JSON only, no preamble" reminder;
   on a second failure, surface the raw response to chat and ask the
   user for a manual `user_intent` paraphrase.
5. Append `## Iteration NN\n\n${design_state_delta}\n\n` to
   `design-state.md`. Surface `per_page_observations` to chat for
   visibility.
6. Compose `mockups/<slug>-NN.html` from `user_intent` + prior mockup
   HTML + `design-state.md`, respecting the design-language CSS.
7. Run `render-html-to-pdf.sh --topic "<topic>" --iteration NN
   --mockup-html <mockups/<slug>-NN.html> --out <session>/<slug>-NN.pdf
   --prerender-out <session>/prerender/`.
8. `push-to-tablet.sh --pdf <session>/<slug>-NN.pdf --cloud-folder
   <cloud-path>/<slug>`.
9. Tell the user: "iter NN pushed; annotate and back out, then say `go`."

### Principles

- **The trigger is the user's permission.** Don't ask "should I render?"
  after every interpret turn.
- **Wrappers stay dumb.** Chain them by their existing CLI shapes; do
  NOT introduce a new wrapper that bundles the loop body. The
  orchestrator is the loop driver, not a wrapper.
- **Disk is the source of truth for cross-turn state.** Chat context
  is for the active turn only. If a question can be answered by
  reading the session folder, read the session folder.
- **Compose by delta, not from scratch.** The next mockup HTML
  preserves the prior mockup's structural skeleton and modifies only
  what `user_intent` asks to change. Restart from scratch only when
  `user_intent` explicitly requests it.
- **JSON parse failure: surface, don't silently proceed.** Show the
  raw response in chat and ask the user to retry or supply a manual
  paraphrase. Never guess from a malformed response.
- **Wrapper failures surface verbatim.** Pass through stderr to chat
  so the user can see what rmapi / Playwright / PyMuPDF reported. No
  paraphrasing of error messages.

## State persistence

`design-state.md` carries two pieces of state main chat reads and writes per turn:
1. The `## Iteration NN` heading for the latest iter (durable cross-turn memory).
2. The `current_mode` frontmatter field (`color | bw | wireframe`).

Both update **atomically** per turn via write-to-temp + rename:

1. Generate the new file content (frontmatter with updated `current_mode`,
   plus all existing iteration sections plus the new `## Iteration NN`).
2. Write to `design-state.md.tmp` in the same directory.
3. `mv design-state.md.tmp design-state.md` (rename is atomic on POSIX
   and atomic-in-practice on NTFS for same-volume same-directory renames).

This is load-bearing for the iter-number staleness check used in
cross-machine resume (see `.claude/features/remarkable-tablet-brainstorm.md`
> "Render modes" > "State encoding"): a crash between the heading write
and the `current_mode` write would let the staleness comparison silently
miss the divergence. Atomic rename guarantees either-both-or-neither.

When main chat handles a poller notification:
- `READY:<NN>` (no mode suffix): carry `current_mode` forward; update heading.
- `READY:<NN>:mode=<X>`: set `current_mode: X`; update heading.
- `STOP:<NN>`: write nothing further to `design-state.md`; run close-session ceremony.

Main chat invokes `bash write-design-state.sh --session-dir <path> --iter NN --mode <color|bw|wireframe>` with the iter's content delta on stdin per turn. The helper handles the write-to-temp + rename internally; main chat does not need to orchestrate the atomic-write step manually.

## Resume flow

When main chat resumes a session (chat restart, fresh machine, etc.),
the active mode comes from one of three sources in priority order:

1. **`current_mode` field in `design-state.md` frontmatter** -- primary.
   If present and valid (`color | bw | wireframe`), use it.

2. **Color default -- short-circuit** -- used in two cases:
   - The field is absent from frontmatter (v1-era or pre-migration session).
   - The frontmatter is unparseable YAML (corrupt or partial-write).

   In both cases, main chat sets `current_mode: color`, writes a fresh
   frontmatter on the next render, and surfaces a warning in chat noting
   the recovery. No pixel-read fallback runs because there's no prior
   mode to recover.

3. **Pixel-read fallback** -- fires only when `current_mode` is present
   AND the iter-number staleness check trips (i.e., `design-state.md`'s
   last `## Iteration NN` is behind the cloud's latest `<slug>-NN.pdf`).
   The flow is:

   1. Pull the latest cloud PDF into a local working directory via
      `pull-from-tablet.sh --cloud-doc <slug>/<slug>-NN --out-dir ...`.
   2. Locate the extracted `<doc-uuid>.pdf` inside the rmdoc dir.
   3. Invoke: `bash skills/sketch-brainstorm/read-prefill.sh <path-to-pulled-pdf>`.

   (Pull-then-read split: the helper is intentionally PDF-path-driven so
   it stays a single-responsibility utility; the bootstrap-dialogue slice
   will own the full orchestration including the pull step. For now main
   chat orchestrates the two-step sequence directly.)

   On clean detection, the helper emits `{"active_mode": "..."}` on
   stdout and exits 0. On rasterization failure or ambiguous sample,
   the helper exits non-zero -- main chat then falls back to Color and
   surfaces a warning, same as the field-absence path.

The iter-number comparison data is the same data bootstrap uses for
iter-counter resolution; no additional rmapi call is needed.

## Cold-start (per-session bootstrap-lite)

On a fresh session - when no current session folder exists - run
bootstrap-lite. The full bootstrap-dialogue slice (design-language
briefing, lock-file check, resume-vs-fresh prompt) is deferred; this
is the minimum viable preamble that gets iter 00 onto the tablet.

1. `rmapi ls` precondition (exit-status only; no contents into
   context). Surface the auth-expired path verbatim if it fails.
2. If `.tmp/sketch-brainstorm/config.json` is absent, ask once where
   on the reMarkable cloud this project's brainstorms should live.
   Save the answer as `{"cloud_path": "<the user's answer>"}` -
   single-key JSON, additive shape (future slices add keys, never
   rename `cloud_path`). Then ensure every segment of `cloud_path`
   exists on the cloud: `rmapi mkdir` is single-level only (no
   `--parents`), so walk the segments and `rmapi mkdir` each one,
   tolerating the literal `entry already exists` error - match the
   exact phrase, not a substring, because the missing-parent error
   reads `directory doesn't exist` and a loose match would silently
   swallow it (see push-to-tablet.sh's `mkdir_stderr` block for the
   precedent). Normalize the path before walking: trim whitespace,
   strip leading and trailing slashes, collapse `//` runs, and skip
   the cloud-root case (empty result has no `rmapi mkdir` target).
   Runs only on this config-absent branch; later sessions skip the
   whole step, and later pushes need only the leaf `<slug>` under
   the now-existing parent tree, which push-to-tablet.sh handles
   directly.
3. Ask the topic. Derive a kebab-case slug silently (lowercase,
   replace non-alphanumerics with `-`, collapse repeats, trim).
4. Ask: *"Initial description for the first sketch, or blank page?"*
5. Cloud collision check: `rmapi ls <cloud-path>/<slug>`. On exit 0,
   prompt the user: resume / rename / "I've deleted the previous
   one, check again". See the feature spec's "Bootstrap and
   chat-launch > step 5a" for the branch behaviors.
6. Run
   `bash bootstrap-session.sh --slug <slug> --topic "<topic>"
   [--description "<description>"]`.
   Capture the printed session-folder path on stdout.
7. Compose `mockups/<slug>-00.html`: description-driven mockup body
   when a description was supplied, empty `<main>` otherwise.
8. Render and push:
   `render-html-to-pdf.sh ... --iteration 00 ... --prerender-out`
   then `push-to-tablet.sh ... --cloud-folder <cloud-path>/<slug>`.
9. Tell the user: *"iter 00 pushed; annotate and back out, then say
   `go`."*

### Principles

- **Bootstrap-lite is the smallest viable preamble.** Don't expand
  its question count beyond what's needed to render iter 00. The
  full bootstrap-dialogue slice is what handles design-language
  briefing, lock check, and resume-vs-fresh.
- **Atomic session-folder creation.** Run `bootstrap-session.sh` only
  after the user has answered all bootstrap-lite questions and the
  collision check has passed. If the user aborts mid-bootstrap, no
  orphan folder appears.

## Smoke test (post-impl validation)

A six-step end-to-end exercise the user runs once after the slice
lands to validate it:

1. Start a fresh session by sending a triggering message in chat (e.g.,
   "let's brainstorm a UI on the tablet for <topic>" or "push a sketch
   to remarkable for <topic>"). Confirm bootstrap-lite asks the
   expected questions, runs the collision check, creates the session
   folder, renders `<slug>-00.pdf`, pushes to cloud.
2. Open `<slug>-00.pdf` on the tablet; sketch a small annotation
   (one circle, one arrow, one text note in the notes region); mark
   the Finish-turn checkbox; back out to the file picker.
3. In chat, type `go`. Confirm:
   - rmapi ls + pull executes
   - render-strokes + composite produce expected outputs in the
     session folder
   - interpret subagent dispatches and `parse-interpret-json.mjs`
     accepts the response
   - design-state.md gains a `## Iteration 01` section
   - `mockups/<slug>-01.html` is composed
   - `<slug>-01.pdf` renders and pushes
   - `prerender/<slug>-01-page1.png` and `-page2.png` exist
4. Confirm `<slug>-01.pdf` landed on the tablet's file picker.
5. Open it; annotate again; type `go`. Confirm iter02 produces.
6. Negative test: with a still-active session, try to start another
   session with the same topic. Confirm the resume-vs-rename prompt
   fires and offers all three documented branches.

### Crash-recovery test

Manually delete `<cloud-path>/<slug>/<slug>-01.pdf` from cloud after
step 4. Run `go` again. Expected: orchestrator should re-render and
re-push iter 01 (NOT advance to iter 02), because the iter counter
resolves from cloud listing - orphan local artifacts are
overwritten on the next render.

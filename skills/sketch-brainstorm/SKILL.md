---
name: sketch-brainstorm
description: Round-trip UI brainstorm loop with a reMarkable tablet. Use when the user wants to sketch on the tablet ("push to tablet", "send sketch to remarkable", "brainstorm UI on the tablet", "pull from tablet", "grab the annotated version"). Renders HTML mockups to PDF at the tablet's viewport, pushes to the reMarkable cloud via rmapi, drives an iter-by-iter render-pull-interpret-render loop. Bootstrap covers lock-conflict check, resume-vs-fresh prompt, and design-language briefing. The poller handles transient rmapi failures with exponential backoff and emits ERROR notifications for persistent failures. Cross-turn compression ships too: the orchestrator runs compression after each push and dispatches a background subagent to archive older turns. Multi-sketch is still deferred to a follow-up slice.
---

# sketch-brainstorm

A skill for design-iteration with handwritten annotations on a reMarkable tablet. The user sketches reactions on the tablet, Claude reads the marks and emits the next mockup.

## STATUS: closed loop + full bootstrap dialogue

Round-trip ships end-to-end and the stroke-region Finish-turn detector
+ one-time calibration ceremony are in place. Verify-before-push is
shipped: the loop body dispatches a fresh subagent against the new
pre-renders (plus the prior turn's pre-renders when available) and
gates the push on a PASS verdict. The poller's ERROR taxonomy + per-
operation exponential backoff (~30 s budget) keep transient rmapi
failures from collapsing long sessions; persistent failures surface as
`ERROR:<context>:<details>` notifications with suppression of repeats.
The full bootstrap dialogue now ships too: lock-file conflict check
(`check-poller-lock.sh`), resume-vs-fresh prompt against
`current-session.json`, and design-language briefing that primes
`<repo-root>/.claude/sketch-brainstorm-mockup.css` on first run.
Cross-turn compression ships too: after each push, the orchestrator runs
`check-compression-needed.sh` and, when triggered, dispatches a background
compression subagent that summarizes turns older than the watermark
(`latest - 5`) into `archive/NNN-pre-summary.md` and rewrites
`design-state.md` to keep only the most recent 6 turns. Multi-sketch is
still deferred to a follow-up slice.

- `render-html-to-pdf.sh` produces a two-page PDF at the Paper Pro viewport from a parametrised HTML template. Page 1 is the mockup page (header, mockup region, small notes area, chrome footer with the Finish-turn checkbox); page 2 is the legend page (header, vocabulary legend, larger notes area, mirrored chrome footer). The user can append further pages on the tablet for long-form notes (handled by the future interpretation slice). `--subtopic` (forward-compat for multi-sketch) and `--prerender-out <dir>` (captures per-page PNGs that the verify-before-push slice consumes).
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

- Pairing helper (`setup-rmapi.sh`); the transport wrappers and `check-rmapi-setup.sh` verifier assume the machine is already paired via the README's one-line `rmapi help` flow
- Multi-sketch iterations (N rendered sketches plus a trailing legend page, for side-by-side alternatives)
- Vocabulary lifecycle (weight-based active / archived split, frecency-style scoring) and close-session ceremony

The automated loop ships today: full bootstrap dialogue + iter01+
render loop + structured interpret JSON. The orchestrator drives the
loop via manual chat triggers (`go` / `pull` / `next` / `iter NN`)
rather than auto-detecting the user's tablet back-out; auto-detection
remains future work.

## Files in this skill

- `SKILL.md` -- this file.
- `README.md` -- condensed design rationale for the skill.
- `vocabulary.md` -- canonical core vocabulary table (gestures and their meanings).
- `render/page-template.html` -- HTML template with `{{topic}}`, `{{iteration_label}}`, `{{mockup_html}}` tokens.
- `render/page-chrome.css` -- styles for header strip, notes region, legend, and Finish-turn checkbox (Color mode).
- `render/page-chrome-bw.css` -- B&W mode stylesheet (monochrome rendering for the page chrome).
- `render/page-chrome-wireframe.css` -- Wireframe mode stylesheet (outline-only rendering for the page chrome).
- `render/render.mjs` -- Node ESM script that substitutes tokens, launches Chromium, and writes the PDF.
- `render-html-to-pdf.sh` -- bash wrapper around `render.mjs`. Outbound render entry point.
- `push-to-tablet.sh` -- bash wrapper for `rmapi put`; outbound cloud upload entry point.
- `pull-from-tablet.sh` -- bash wrapper for `rmapi get` + `.rmdoc` extraction; inbound cloud download entry point.
- `_lib.sh` -- internal helpers sourced by other wrappers (rmapi auth precondition; shared Python venv bootstrap with requirements.txt drift detection).
- `render/render-strokes.py` -- converts per-page `.rm` stroke files to SVG overlays.
- `render-strokes.sh` -- bash wrapper for the inbound stroke pipeline; reuses the shared venv.
- `render/composite-annotated.py` -- composites stroke SVGs onto PDF pages as PNGs (PyMuPDF + Pillow).
- `composite-annotated.sh` -- bash wrapper for the composite step; reuses the shared venv.
- `render/prerender-pages.py` -- PyMuPDF-based PDF-to-PNG rasterizer; invoked by `render-html-to-pdf.sh`'s `--prerender-out` flag to feed the verify-before-push slice.
- `bootstrap-session.sh` -- creates the per-session local folder skeleton and primes `design-state.md` with frontmatter + `## Iteration 00`. Idempotent. Invokes `check-rmapi-setup.sh` as a defense-in-depth precondition before any filesystem mutation, and registers the new session via `update-session-index.sh add` after creating the folder.
- `update-session-index.sh` -- bash wrapper around `session_index.py`; subcommands `add --session-dir <dir> --slug <slug>` (called by `bootstrap-session.sh`), `set-active --session-dir <dir>` (called by the orchestrator's resume / pick-older branches in the full bootstrap dialogue), and `increment-turn --session-dir <dir>` (called by the iter01+ loop body after each successful push).
- `render/session_index.py` -- read / write `.tmp/sketch-brainstorm/current-session.json`: `read_index`, `add_session` (idempotent on session_dir), `set_active`, `increment_turns`, `SessionIndexError`. Atomic writes via `_atomic_write`.
- `render/_session_index_dispatch.py` -- argparse-based subcommand router invoked by `update-session-index.sh`; one try/except `SessionIndexError` wraps all three subcommand dispatches. Internal helper.
- `test_update_session_index.sh` -- bash test for the wrapper (subcommand routing, repo-root resolution, error paths, increment-turn cumulative + negative).
- `render/test_session_index.py` -- unit tests for the index library (add idempotency, active-pointer demotion, increment_turns cumulative + negative, malformed-JSON handling).
- `check-poller-lock.sh` -- bash wrapper that prints one JSON line on stdout classifying `.tmp/sketch-brainstorm/poller.lock` as `absent`, `stale`, or `alive`. Always exits 0; lock states are data, not errors. The full bootstrap dialogue's step 1 reads this and branches into the force-claim prompt on `alive`.
- `render/check_poller_lock.py` -- read-only lock classifier: `check_lock(path)` returns a dict with `status` plus supporting fields (pid, heartbeat_age_s, reason). PID-alive uses `os.kill(pid, 0)`; heartbeat staleness threshold is 60 s to tolerate one missed iteration at the 30 s poll cadence.
- `test_check_poller_lock.sh` -- bash test for the wrapper (JSON parse, repo-root override, exit-0 invariant).
- `render/test_check_poller_lock.py` -- unit tests for `check_lock` covering absent / alive / stale-pid-dead / stale-heartbeat / stale-malformed branches.
- `check-compression-needed.sh` -- bash wrapper printing a single JSON line classifying whether the named session needs compression. Exits 0 when a valid session-dir is supplied and the helper succeeds; exits 2 on argument error or unreadable session (e.g., permission error scanning `archive/`). Trigger states (true/false) are data, not errors. The loop body's step 8.6 reads this and dispatches the compression subagent on `trigger: true`.
- `render/check_compression_needed.py` -- compression trigger logic: scans `## Iteration NN` headings in `design-state.md`, applies the watermark rule (latest - WATERMARK_OFFSET; default 5). Returns `{trigger, reason}` on no-trigger; adds `turns_to_archive`, `turns_to_keep`, `archive_nnn`, `latest_turn`, `watermark_turn` on trigger. Stdlib-only; reads design-state.md and lists `archive/` for sequence-number resolution but never parses archive YAML.
- `render/test_check_compression_needed.py` -- unit tests for the trigger logic (no-trigger, single-turn trigger, multi-turn trigger, gap handling, NNN resolution with existing archives, absent design-state.md).
- `test_check_compression_needed.sh` -- bash wrapper test (absent state, below-threshold, above-threshold, missing argument).
- `write-archive.sh` -- bash wrapper for the archive writer; reads parsed compression-subagent JSON on stdin, takes `--session-dir`, `--turns-to-archive`, `--turns-to-keep`.
- `render/write_archive.py` -- archive writer + active-head rewriter. Validates structural invariants (archived turns absent from new head; kept turns present; no extra turns), resolves next NNN, performs the two-step atomic write (archive first then design-state.md). Stdlib-only; reuses `_atomic_write`.
- `render/test_write_archive.py` -- unit tests for the writer (happy path, gap-tolerant NNN resolution, three-way structural-invariant rejection, archive dir auto-create, archive-before-active-head write order).
- `test_write_archive.sh` -- bash wrapper test (happy path, structural rejection, missing-flag rejection).
- `parse-compress-response.mjs` -- shell-callable JSON parse + validate helper for the compression subagent's response (`{archive_content, new_active_head_content}` with frontmatter-prefix rule on both fields + forward-compat unknown-field tolerance). Authoritative schema in module docblock.
- `test_compress_parse.mjs` -- node:test cases for `parseCompressResponse` (happy path, CRLF, missing/empty fields, malformed JSON, frontmatter-prefix rule on both fields, forward-compat tolerance, tight-block trailing-newline constraint).
- `compress-prompt.md` -- prompt template for the compression subagent. Read by the orchestrator; not directly executable. Tokens: `{ACTIVE_HEAD_PATH}`, `{TURNS_TO_ARCHIVE}`, `{TURNS_TO_KEEP}`, `{PRIOR_ARCHIVES}`, `{ARCHIVE_NNN}`, `{CREATED_TIMESTAMP}`.
- `check-rmapi-setup.sh`: read-only verifier for the rmapi auth-bootstrap security posture (rmapi on PATH, auth, hook). Safe for Claude to invoke.
- `parse-interpret-json.mjs` -- shell-callable JSON parse + validate helper for the interpret subagent's response. Authoritative schema lives at the top of this file.
- `parse-verify-response.mjs` -- shell-callable JSON parse + validate helper for the verify subagent's response (`{verdict, reason}` with asymmetric-reason rule). Authoritative schema lives at the top of this file.
- `_parse_cli_runner.mjs` -- internal shared CLI driver re-used by the three `parse-*-response.mjs` modules (stdin -> parseFn -> stdout JSON or stderr+exit-1). Stderr prefix derived from `process.argv[1]` so a parser rename needs no call-site update. Not a public entry point; imported only by sibling parsers.
- `_parse_fence.mjs` -- internal shared fence-extraction helper exporting `extractFencedJson(text)`. Single source of truth for the fenced-JSON regex + CRLF-tolerant decode used by all three parsers; each parser layers its schema-specific validation on top of the returned object.
- `derive-calibration.sh` -- bash wrapper for the one-time calibration ceremony; runs derive_calibration.py against a pulled five-dot calibration rm-dir to produce calibration.json.
- `render/derive_calibration.py` -- calibration derivation: five-centroid Hungarian assignment, median scale derivation, asymmetry + residual verification, writes calibration.json.
- `detect-marks.sh` -- bash wrapper for the per-turn detector.
- `render/detect_marks.py` -- stroke-region detector: reads calibration.json, inverse-transforms each registered checkbox PDF rectangle to .rm coordinates, hit-tests strokes, emits structured JSON keyed by box name (finish_turn, end_session, mode_color, mode_bw, mode_wireframe).
- `poll-tablet.sh` -- bash wrapper for the background poller that wraps the detector and emits the `READY:NN` / `READY:NN:mode=X` / `STOP:NN` / `ERROR:<context>:<details>` protocol on stdout.
- `render/poll_tablet.py` -- background polling implementation: rmapi-driven pull cadence, detector dispatch, mode/stop signalling, ERROR classification + per-operation exponential backoff with emission suppression.
- `render/test_poll_tablet.py` -- unit tests for the poller's state machine, signal-emission logic, error classification table, retry/backoff behavior, and ERROR-emission suppression.
- `write-design-state.sh` -- bash wrapper for the atomic frontmatter + section update helper; reads delta on stdin.
- `render/write_design_state.py` -- atomic write-to-temp + rename implementation; preserves prior iterations and updates `current_mode` frontmatter.
- `render/test_write_design_state.py` -- unit tests for the atomic-write helper (frontmatter merge, iteration append, idempotency).
- `read-prefill.sh` -- bash wrapper for the pixel-read pre-fill helper used by the resume flow's mode-recovery fallback.
- `rmapi-conf-deny-hook.sh`: PreToolUse hook blocking access to the rmapi token conf. Wired via `~/.claude/settings.json` per the install instructions in `README.md`.
- `render/read_prefill.py` -- rasterizes a pulled PDF and reads a known pixel sample to infer the active mode; accepts calibration dict as a parameter (main() loads via load_calibration() and passes down); emits `{"active_mode": "..."}` on success.
- `render/test_read_prefill.py` -- unit tests for the pixel-read mode inference.
- `render/test_geometry.py` -- capsule-area geometry tests; stdlib-only (imports _geometry.py directly; no venv or rmscene stub required).
- `render/_chrome_boxes.py` -- dependency-free shared data module: BOX_REGISTRY (5-box PDF coordinates), VALID_MODES tuple, ITER_NN_RE regex. Importable from both venvs (rmscene-equipped and fitz-equipped) without transitive deps.
- `render/_calibration.py` -- calibration file management: SKILL_ROOT, CALIBRATION_JSON, CALIBRATION_SCHEMA_VERSION, CalibrationError, load_calibration; stdlib-only (no rmscene dependency).
- `render/_geometry.py` -- capsule-area geometry primitives (points_bbox, capsule_area, _liang_barsky_clip, _point_in_box); stdlib-only (math only). Extracted from _rm_strokes so test_geometry.py runs without the venv.
- `render/_atomic_write.py` -- atomic_write_text helper (write-to-temp + os.replace); shared by poll_tablet.write_lock and write_design_state.write.
- `render/_rm_strokes.py` -- shared .rm parser and manifest reader: PAGE_W/PAGE_H constants, PEN_COLORS, collect_lines, ManifestError, manifest_pages (dual-schema modern+legacy), ordered_rm_files (delegates to manifest_pages). Single source of truth for .rm coordinate system and page ordering. CalibrationError and load_calibration live in _calibration.py.
- `render/_test_helpers.py` -- shared kebab-module stub harness (STUB_MODULE_NAMES, load_kebab_module, stubbed_kebab_loads context manager); stdlib-only; used by test_composite_annotated.py and test_render_strokes.py.
- `calibration.json` -- committed at the skill root; firmware-versioned scale produced by the calibration ceremony. Refreshed only when firmware changes invalidate the constant.
- `test-fixtures/calibration-paper-pro-fw<version>.rmdoc` -- captured reference .rmdoc from the calibration ceremony; consumed by test_derive_calibration.py's fixture smoke test.
- `render/test_detect_marks.py` -- JSON-shape test for the detector (stubs rmscene; runs stdlib-only).
- `render/test_derive_calibration.py` -- fixture smoke test for the calibration derivation (uses the committed .rmdoc + the venv).
- `interpret-prompt.md` -- prompt template for the interpretation subagent (read by the orchestrator; not directly executable).
- `verify-prompt.md` -- prompt template for the verify subagent (read by the orchestrator; not directly executable).
- `test_interpret_parse.mjs` -- node:test cases for `parseInterpretResponse` (happy path, CRLF, missing/wrong-type fields, malformed JSON).
- `test_verify_parse.mjs` -- node:test cases for `parseVerifyResponse` (PASS/FAIL happy paths, CRLF, asymmetric-reason rule, missing/wrong-cased fields, forward-compat unknown-field tolerance, missing-fence rejection).
- `test_bootstrap_session.sh` -- bash test for `bootstrap-session.sh` (folder skeleton, frontmatter, idempotency re-run, negative-input rejection).
- `render/test_render_format.mjs` -- node:test cases for `formatIterationLabel`.
- `render/test_project_css_injection.mjs` -- node:test cases for the `--project-mockup-css` CLI flag plumbing through `render.mjs`'s `parseArgs` (option accepted, correct failure mode on missing required flags; visual injection covered by smoke test).
- `render/test_prerender_pages.py` -- end-to-end test for `prerender-pages.py` against a real two-page PDF.
- `render/test_render_strokes.py` -- unit tests covering `render-strokes.py` main() calibration-present and auto-fit branches; also checks PAGE_W/PAGE_H parity with composite-annotated; uses shared kebab-module stub harness from _test_helpers.py.
- `render/test_composite_annotated.py` -- unit tests for `composite-annotated.py`'s page-pattern regex, numeric sort, and resolution constants (now also cross-checks `prerender-pages.py`); uses shared kebab-module stub harness from _test_helpers.py.
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
- `--mockup-html <path>` (optional): file whose contents are substituted into the mockup region. Iter 00 renders may pass an empty mockup or a description-driven mockup, depending on the user's answer to the bootstrap "initial description or blank page?" prompt; iter 01+ pass orchestrator-composed mockup HTML derived from the prior turn's `user_intent`.
- `--subtopic <string>` (optional): forward-compat hook for the deferred multi-sketch slice; substituted into the page header alongside the topic when present.
- `--prerender-out <dir>` (optional): captures per-page PNGs of the rendered PDF (`<slug>-NN-page1.png`, `-page2.png`, ...) via PyMuPDF; consumed by the verify-before-push slice and useful for spot-checking what was pushed.

Windows: the bash wrapper requires Git Bash or WSL. PowerShell users invoke via `bash render-html-to-pdf.sh ...`.

The skill resolves Playwright from `skills/sketch-brainstorm/node_modules` (per-skill install, run `npm install` from the skill folder once) or falls back to `$REPO_ROOT/web/node_modules` for in-repo incubation. Gist consumers: `npm install` in the skill folder.

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
{"per_page": [
  {"page": 1, "boxes": {
    "finish_turn":    {"area_rm_sq": 0.0, "marked": false},
    "end_session":    {"area_rm_sq": 0.0, "marked": false},
    "mode_color":     {"area_rm_sq": 0.0, "marked": false},
    "mode_bw":        {"area_rm_sq": 0.0, "marked": false},
    "mode_wireframe": {"area_rm_sq": 0.0, "marked": false}
  }},
  ...
]}
```

Each per-page entry reports every registered checkbox by name, with the union stroke-capsule `area_rm_sq` inside the box's `.rm`-space rectangle and a `marked` boolean from comparing that area against the per-box threshold. `per_page` always covers every rendered page (length comes from the `.content` manifest's `cPages.pages[]`, not from `.rm` file presence); pages with no `.rm` file get synthesized entries with every box at `area_rm_sq: 0.0, marked: false`.

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

## Verify entry point

After `render-html-to-pdf.sh --prerender-out` produces the per-page PNGs for the just-rendered iteration, dispatch a fresh verify subagent to visually sanity-check the render against the user's intent before pushing to the cloud:

1. Read `skills/sketch-brainstorm/verify-prompt.md` (the prompt template).
2. Substitute the bracketed tokens:
   - `{NEW_PRERENDER_PATHS}` - newline-bullet absolute paths to the just-rendered `<session>/prerender/<slug>-NN-page*.png` files.
   - `{PRIOR_PRERENDER_PATHS}` - newline-bullet absolute paths to the prior iteration's `<session>/prerender/<slug>-(NN-1)-page*.png` files when present (NN > 00 and the prior turn's pre-renders are on disk); the literal string `none` otherwise (iter 00 or prior absent). With `none`, the verifier runs in absolute-only layout-sanity mode; with paths, it adds the differential "did the requested change visually manifest?" check.
   - `{USER_INTENT}` - this turn's `user_intent` text from the prior interpret turn for loop-body iterations. For the iter 00 bootstrap render there is no prior interpret turn, so the substitution depends on the sub-path: the user's initial description verbatim for the description-driven path, and the literal string `(blank page; no specific intent; absolute layout-sanity only)` for the blank-page path. Threading this literal text into the prompt keeps the differential-vs-absolute mode explicit to the verifier and stops the orchestrator from improvising substitution per session.
3. Dispatch via the Agent tool with `subagent_type: general-purpose`. Pass the substituted prompt body.
4. Receive the subagent's response. Parse the fenced JSON block via `node skills/sketch-brainstorm/parse-verify-response.mjs` (stdin = raw response; stdout = canonicalized JSON; exit 0 on valid). The parsed object has two fields: `verdict` (`"PASS"` or `"FAIL"`, strict-cased) and `reason` (empty string on PASS, non-empty sentence naming the failure mode on FAIL). The asymmetric-reason rule (PASS implies empty reason, FAIL implies non-empty reason) is hard-validated; a subagent that returns `{"verdict":"PASS","reason":"looks good"}` is rejected, not coerced. On parse failure (parse helper exits non-zero), retry the verify dispatch once with a "JSON only, no preamble; conform to the contract" reminder appended to the prompt; on a second parse failure, surface the raw response in chat with the caveat *"verifier returned malformed output twice; proceeding to push without verify-gate."* and proceed to the push step. Parse failures do NOT consume the FAIL retry budget below.
5. Branch on the verdict:
   - **PASS**: proceed to the push step.
   - **FAIL**: regenerate the iteration's mockup HTML with the verifier's `reason` folded in as a constraint, re-render via `render-html-to-pdf.sh --prerender-out`, and re-dispatch verify. Retry budget is 2 re-renders per turn (the failed attempt's HTML and rendered PDF are overwritten on each retry; previous failed attempts have no value).
   - **After 2 failed verifies**: pause and ask the user in chat: *"Verifier flagged the same issue after 2 retries. Push anyway, or abort?"* Present exactly two options: push anyway / abort. If the user chooses abort, skip the push and report the verifier's last `reason` verbatim in chat. If the user chooses push anyway, or does not respond within a reasonable wait (default on timeout: push anyway), proceed to the push step and surface the verifier's last `reason` verbatim in chat with the caveat *"verifier flagged: <reason> - 2 retries did not resolve it; check on the tablet."* The retry counter is chat-local per turn.

This step is orchestrator-side, not a shell wrapper: the Agent tool is Claude Code's; shells can't dispatch it. The fresh-per-turn discipline matches the interpretation entry point - the verifier sees only the pre-render PNGs plus the substituted text, no prior chat context.

## Compress entry point

After a successful `push-to-tablet.sh` (step 8) and the
`update-session-index.sh increment-turn` call (step 8.5), check whether
the active session needs cross-turn compression and, when triggered,
dispatch a background compression subagent.

1. Run `bash skills/sketch-brainstorm/check-compression-needed.sh <session-dir>`.
   The wrapper prints a single JSON line on stdout. Parse it. The
   `trigger` field is `true` or `false`.
2. On `trigger: false`, proceed to step 9 (tablet handoff) with no
   compression work.
3. On `trigger: true`, the JSON also carries `turns_to_archive`,
   `turns_to_keep`, `archive_nnn`, `latest_turn`, and `watermark_turn`.
   Read `skills/sketch-brainstorm/compress-prompt.md`. Substitute the
   tokens:
   - `{ACTIVE_HEAD_PATH}`: absolute path to `<session>/design-state.md`.
   - `{TURNS_TO_ARCHIVE}`: the comma-joined `turns_to_archive` list.
   - `{TURNS_TO_KEEP}`: the comma-joined `turns_to_keep` list.
   - `{PRIOR_ARCHIVES}`: newline-bullet absolute paths to existing
     `<session>/archive/*-pre-summary.md` files in sort order, or the
     literal string `none` if the directory is empty.
   - `{ARCHIVE_NNN}`: the `archive_nnn` field verbatim.
   - `{CREATED_TIMESTAMP}`: a fresh ISO 8601 UTC timestamp.
4. Dispatch via the Agent tool with `subagent_type: general-purpose`
   and `run_in_background: true`. Compression is off the critical path
   per design ("Async compression off the critical path"); proceed to
   step 9 (tablet handoff) immediately. When the background agent's
   completion notification arrives (delivered asynchronously by the
   harness), continue with the parse-and-write sequence below.
   On agent completion, pipe the response through
   `node skills/sketch-brainstorm/parse-compress-response.mjs`
   (stdin = raw response; stdout = canonicalized JSON; exit 0 on valid).
5. On parse success, invoke
   `bash skills/sketch-brainstorm/write-archive.sh
   --session-dir <session> --turns-to-archive <list>
   --turns-to-keep <list>` with the parsed JSON on stdin.
6. On parse failure, write failure, or structural-invariant rejection,
   surface the error in chat with the prefix `compression skipped: `
   and continue. The next turn re-triggers from the unchanged
   `design-state.md` (idempotent retry per design).

### Deferring a dispatch

If a new `READY:<NN>` notification fires while a previous compression
subagent is still running, the orchestrator does NOT spawn a second
compression in parallel. Instead, the new turn's loop body skips
the compression step; the next turn's check re-evaluates and dispatches
then. Active state grows briefly above the watermark in that case,
bounded by turn cadence rather than unbounded. This avoids overlapping
writes to `design-state.md` from concurrent subagents.

The in-flight tracking is session-local: the orchestrator's memory of
"a compression is running" clears on chat restart. A background agent
that times out or silently fails will not deliver a completion
notification; on the next triggered turn the orchestrator sees no
pending agent and dispatches a fresh one. Permanent suppression cannot
happen across sessions; within a session a stuck agent is resolved by
restarting the chat (the orphan archive, if any, is harmless; the
next cycle re-archives idempotently).

This step is orchestrator-side, not a shell wrapper: the Agent tool is
Claude Code's; shells can't dispatch it. The fresh-per-turn discipline
matches interpret + verify: the subagent reads the active head and
prior archives via its own Read tool, no parent-context overlap.

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
5. Invoke: `bash skills/sketch-brainstorm/write-design-state.sh
   --session-dir <session> --iter NN --mode <current_mode>` with the
   iteration's design-state delta on stdin. The helper performs the
   atomic frontmatter + section update; main chat does not append
   manually. Surface `per_page_observations` to chat for visibility.
6. Compose `mockups/<slug>-NN.html` from `user_intent` + prior mockup
   HTML + `design-state.md`, respecting the design-language CSS.
7. Run `render-html-to-pdf.sh --topic "<topic>" --iteration NN
   --mockup-html <mockups/<slug>-NN.html> --current-mode <mode>
   --out <session>/<slug>-NN.pdf --prerender-out <session>/prerender/`.
   The mode comes from `design-state.md`'s `current_mode` frontmatter
   (which step 5 just wrote).
7.5. Dispatch the verify subagent per the "Verify entry point" section
   above. Token substitutions for this loop-body iteration:
   - `{NEW_PRERENDER_PATHS}` = paths to `<session>/prerender/<slug>-NN-page*.png`.
   - `{PRIOR_PRERENDER_PATHS}` = paths to `<session>/prerender/<slug>-(NN-1)-page*.png`
     when present and NN > 00; literal `none` otherwise.
   - `{USER_INTENT}` = this turn's `user_intent` text (the string step 4 distilled,
     the same one that drove the step 6 mockup composition).
   On `FAIL`, regenerate `mockups/<slug>-NN.html` by re-running step 6 with the
   verifier's `reason` added as a constraint, re-run step 7 to re-render and
   capture fresh pre-renders, and re-dispatch verify. Verdict branching, retry
   budget, push-anyway caveat, and parse-failure handling all follow the Verify
   entry point section's rules verbatim.
8. `push-to-tablet.sh --pdf <session>/<slug>-NN.pdf --cloud-folder
   <cloud-path>/<slug>`.
8.5. `bash skills/sketch-brainstorm/update-session-index.sh increment-turn
   --session-dir <session>`. Advances the session's `turns` counter in
   `current-session.json` so the resume-vs-fresh prompt at the top of the
   next bootstrap surfaces an honest count. Iter 00 (initial bootstrap
   render) does not increment; only completed loop-body iterations count
   as turns.
8.6. Run `bash skills/sketch-brainstorm/check-compression-needed.sh <session-dir>`.
   On `trigger: true`, dispatch the compression subagent per the
   "Compress entry point" section above (background; do not block step 9
   on completion). On `trigger: false`, proceed directly to step 9.
   On non-zero exit (e.g., permission error on the archive directory),
   surface `compression skipped: <stderr>` in chat and continue; the
   next loop body re-evaluates from the unchanged `design-state.md`.
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
- `ERROR:<context>:<details>`: surface in chat with a recovery hint keyed to `<context>` (e.g., `auth-expired` -> re-pair via the future `setup-rmapi.sh`; `rmapi-pull-failed-doc-missing` -> re-push the iter or check the cloud path). The poller keeps polling silently; identical errors are suppressed until a successful tick clears the state. Do not update `design-state.md` on ERROR; the iteration's state is unchanged.

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

## Full bootstrap (per-session)

On a fresh session - when no current session folder exists, or when
the user wants to switch sessions - run the full bootstrap dialogue.
This is the per-session preamble that resolves lock conflicts, offers
resume of an existing brainstorm, primes the project's design-language
CSS on first run, and gets `<slug>-00.pdf` onto the tablet.

Precondition: rmapi readiness. The orchestrator no longer needs to
run `check-rmapi-setup.sh` as a separate gate; `bootstrap-session.sh`
invokes it internally as a defense-in-depth precondition (see step 6
below). The verifier remains available for diagnostic use when the
user reports a pairing-completed-but-still-broken state.

1. **Lock check.** Run `bash check-poller-lock.sh`. Parse the JSON
   line on stdout (always exits 0; lock states are data, not errors).
   The `status` field is one of `absent`, `stale`, or `alive`.
   - `status: absent` or `status: stale`: proceed to step 2. The
     poller spawn at step 8 claims the lock cleanly; no orchestrator
     action is needed to clear a stale lock. If `stale` includes
     `"reason": "error"` (the Python check failed to import — venv or
     path issue), surface a one-line note in chat before proceeding so
     the user can diagnose the tool failure independently.
   - `status: alive`: surface the force-claim prompt:
     > Existing polling script for this project: PID {pid}, last
     > heartbeat {heartbeat_age_s}s ago. Cancel (resume in the other
     > chat) or force-claim (kill the held PID and take over)?

     On cancel, exit the bootstrap and tell the user to use the other
     chat. On force-claim, kill the PID (`kill {pid}` on Unix,
     `taskkill /F /PID {pid}` on Windows), then proceed to step 2.

2. **Active-session check.** Read
   `.tmp/sketch-brainstorm/current-session.json` if present. If
   `active_session` is set or `history` is non-empty, surface the
   resume-vs-fresh prompt:
   > Existing state found: N turns on "{slug}" (last activity
   > {date}). Resume, start fresh, or pick up an older brainstorm?

   The `{date}` derives from the active session's `session_dir`
   basename (`<YYYY-MM-DD>-<slug>`); `N` is the entry's `turns` count.
   - **Resume**: skip ahead to step 9 (tablet handoff). The latest
     `<slug>-NN.pdf` is already on the tablet from before, so no new
     render or push is needed. If the previously-active session is
     the resume target the index is already correct; otherwise call
     `bash update-session-index.sh set-active --session-dir <chosen>`
     (no-op when already active).
   - **Older brainstorm**: list `history` entries by slug for the
     user to pick from, then call
     `bash update-session-index.sh set-active --session-dir <chosen>`
     and skip to step 9.
   - **Fresh**: continue to step 3.

3. **Topic and optional initial description.** Ask the topic
   ("warmup gate UI", "pitch display layout"). Derive a kebab-case
   slug silently (lowercase, replace non-alphanumerics with `-`,
   collapse repeats, trim). At the same prompt, ask: *"Initial
   description for the first sketch, or blank page?"* Either way the
   user reacts to `<slug>-00.pdf` on the tablet; there is no
   "skip iter-00" branch.

4. **Cloud path resolution.** If `.tmp/sketch-brainstorm/config.json`
   is absent, ask once where on the reMarkable cloud this project's
   brainstorms should live. Save the answer as
   `{"cloud_path": "<the user's answer>"}` - single-key JSON, additive
   shape (future slices add keys, never rename `cloud_path`). Then
   ensure every segment of `cloud_path` exists on the cloud: `rmapi
   mkdir` is single-level only (no `--parents`), so walk the segments
   and `rmapi mkdir` each one, tolerating the literal `entry already
   exists` error - match the exact phrase, not a substring, because
   the missing-parent error reads `directory doesn't exist` and a
   loose match would silently swallow it (see push-to-tablet.sh's
   `mkdir_stderr` block for the precedent). Normalize the path before
   walking: trim whitespace, strip leading and trailing slashes,
   collapse `//` runs, and skip the cloud-root case (empty result has
   no `rmapi mkdir` target). Runs only on this config-absent branch;
   later sessions skip the whole step, and later pushes need only the
   leaf `<slug>` under the now-existing parent tree, which
   push-to-tablet.sh handles directly.

5. **Design-language briefing.** On first run in a project (when
   `<repo-root>/.claude/sketch-brainstorm-mockup.css` does not exist),
   ask: *"What's the feel for these mockups? A sentence about the
   aesthetic, a reference URL, or a few preference words all work; or
   say `skip` to iterate later."* On a substantive answer, compose a
   baseline CSS reflecting the agreement and write it to
   `<repo-root>/.claude/sketch-brainstorm-mockup.css` via the Write
   tool. On `skip`, proceed without the file; `render.mjs` falls back
   to chrome-only styling. Returning to a project with the file
   already present skips the prompt.

5a. **Cloud collision check.** Run `rmapi ls <cloud-path>/<slug>`. On
    exit 0, prompt the user: resume / rename / "I've deleted the
    previous one, check again". See the feature spec's "Bootstrap
    and chat-launch > step 5a" for the branch behaviors. Cross-machine
    resume (the cloud folder exists but no local session folder
    matches) is a known gap routed to a future slice.

6. **Session folder creation.** Run
   `bash bootstrap-session.sh --slug <slug> --topic "<topic>"
   [--description "<description>"]`. Capture the printed
   session-folder path on stdout. The wrapper (a) invokes
   `check-rmapi-setup.sh` as a defense-in-depth precondition before
   any filesystem mutation, and (b) registers the new session as
   active in `current-session.json` via `update-session-index.sh add`
   after creating the folder.

7. **Initial render and push.** Compose `mockups/<slug>-00.html`:
   description-driven mockup body when a description was supplied,
   empty `<main>` otherwise. Render:
   `render-html-to-pdf.sh ... --iteration 00 ... --prerender-out
   <session>/prerender/`. `render-html-to-pdf.sh` auto-detects
   `<repo-root>/.claude/sketch-brainstorm-mockup.css` when present and
   injects it; with no project CSS, chrome-only styling applies. The
   `--prerender-out` PNGs feed the verify dispatch.

   Dispatch the verify subagent per the "Verify entry point" section
   above. Token substitutions for the iter-00 bootstrap path:
   - `{NEW_PRERENDER_PATHS}` = newline-bullet absolute paths to
     `<session>/prerender/<slug>-00-page*.png`.
   - `{PRIOR_PRERENDER_PATHS}` = the literal string `none` (iter 00
     has no prior turn; the verifier runs in absolute-only
     layout-sanity mode).
   - `{USER_INTENT}` depends on the sub-path from step 3:
     - Description-driven: the user's initial description verbatim.
     - Blank-page: the literal string `(blank page; no specific
       intent; absolute layout-sanity only)`. Threading this literal
       text into the prompt keeps the differential-vs-absolute mode
       explicit to the verifier and stops the orchestrator from
       improvising substitution per session.

   Verdict branching, retry budget, push-anyway caveat, and
   parse-failure handling all follow the Verify entry point section's
   rules verbatim. On `FAIL` retry, regenerate `mockups/<slug>-00.html`
   with the verifier's `reason` folded in as a constraint, re-render,
   and re-dispatch verify.

   On PASS (or push-anyway after retries), push:
   `push-to-tablet.sh ... --pdf <session>/<slug>-00.pdf
   --cloud-folder <cloud-path>/<slug>`.

8. **Spawn polling script.** Launch `bash poll-tablet.sh ...` as a
   background process via `Bash(run_in_background=true)`. The poller
   writes `.tmp/sketch-brainstorm/poller.lock` at startup and updates
   `last_heartbeat` each tick.

9. **Tablet handoff.** Tell the user: *"iter 00 pushed; annotate and
   back out, then say `go`."* (For the resume / older-brainstorm
   branches above, adapt the message: *"`<slug>-NN.pdf` is on the
   tablet from your prior session; annotate and back out, then say
   `go`."*) The orchestrator now waits on poller notifications or
   manual chat triggers (`go` / `pull` / `next` / `iter NN`) before
   driving the next loop body iteration.

### Principles

- **Atomic session-folder creation.** Run `bootstrap-session.sh` only
  after the user has answered all bootstrap questions and the
  collision check has passed. If the user aborts mid-bootstrap, no
  orphan folder appears.
- **Lock-conflict resolution is a chat decision, not an automated
  retry.** Never force-claim the lock without surfacing the
  force-claim prompt first; the cancel branch exists so the user can
  resume the other chat without losing it.
- **Design-language briefing is skippable.** The orchestrator never
  blocks iter 00 on the user composing a CSS vocabulary up-front;
  the fallback to chrome-only styling keeps the loop moving while
  the user iterates on the design language through sketching itself.

## Smoke test (post-impl validation)

An end-to-end exercise the user runs once after a slice lands to
validate it:

1. Start a fresh session by sending a triggering message in chat (e.g.,
   "let's brainstorm a UI on the tablet for <topic>" or "push a sketch
   to remarkable for <topic>"). Confirm bootstrap asks the expected
   questions, runs the collision check, creates the session folder,
   renders `<slug>-00.pdf`, pushes to cloud.
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
   - verify subagent dispatches with the new pre-renders + the iter 00
     pre-renders + the iter 01 `user_intent`;
     `parse-verify-response.mjs` accepts the verdict and the push
     proceeds on PASS
4. Confirm `<slug>-01.pdf` landed on the tablet's file picker.
5. Open it; annotate again; type `go`. Confirm iter02 produces.
6. Negative test: with a still-active session, try to start another
   session with the same topic. Confirm the resume-vs-rename prompt
   fires and offers all three documented branches.
7. Verify-failure test: edit `mockups/<slug>-01.html` to embed a
   literal `{{topic}}` token (template-typo simulation), re-render
   with the iter 00 mockup as prior pre-render. Confirm the verify
   subagent returns FAIL with a reason naming the literal token,
   the orchestrator regenerates and re-renders, and after at most
   2 retries either lands PASS or surfaces the push-anyway caveat
   in chat with the verifier's last reason.
8. Full-bootstrap branches test, four checks (run each from a clean
   chat against the same project):
   - **Lock-conflict force-claim.** With a poller running from a
     prior chat, start a new chat and trigger bootstrap. Confirm
     `check-poller-lock.sh` returns `status: alive`, the orchestrator
     surfaces the force-claim prompt with the PID and heartbeat age,
     and choosing force-claim kills the held PID before proceeding to
     step 2.
   - **Resume-vs-fresh prompt.** With at least one entry in
     `current-session.json` history, trigger bootstrap and confirm
     the resume prompt fires with turn count, slug, and date.
     Choosing resume jumps to the tablet handoff without re-rendering;
     choosing fresh continues into step 3; choosing pick-older lists
     the available slugs and routes through
     `update-session-index.sh set-active`.
   - **Design-language briefing.** With no
     `<repo-root>/.claude/sketch-brainstorm-mockup.css` present,
     trigger bootstrap and answer the design-language prompt with a
     short aesthetic. Confirm the file is written and the iter-00
     render injects its styles. Then re-run with the file present and
     confirm the prompt is skipped. Run once more with the `skip`
     answer (after removing the file) and confirm the render falls
     back to chrome-only styling.
   - **Defense-in-depth gate.** Disable the `~/.claude/settings.json`
     PreToolUse hook for `rmapi conf` access, then trigger bootstrap.
     Confirm `bootstrap-session.sh` runs `check-rmapi-setup.sh`
     internally and refuses to mutate the filesystem when the gate
     trips.

### Crash-recovery test

Manually delete `<cloud-path>/<slug>/<slug>-01.pdf` from cloud after
step 4. Run `go` again. Expected: orchestrator should re-render and
re-push iter 01 (NOT advance to iter 02), because the iter counter
resolves from cloud listing - orphan local artifacts are
overwritten on the next render.

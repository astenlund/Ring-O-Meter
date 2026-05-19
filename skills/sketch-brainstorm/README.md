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

Both transport directions work end-to-end and the full interpretation pipeline (strokes -> composite -> multimodal subagent -> structured JSON) is functionally validated. **Outbound**: render an HTML mockup to a PDF, push to a folder on the reMarkable cloud via rmapi. **Inbound**: pull a cloud document with `rmapi get`, extract the `.rmdoc` archive, parse the per-page `.rm` files into transparent SVG overlays, composite each overlay onto its source PDF page, dispatch a fresh subagent with the composite PNGs + the vocabulary, receive a structured JSON block with `user_intent`, `design_state_delta`, and `per_page_observations`. The iter01+ loop that consumes `user_intent` to drive the next render, `design-state.md` for cross-turn memory, and bootstrap-lite (the minimum viable preamble that gets iter 00 onto the tablet) all ship today. The stroke-region checkbox detector and one-time calibration ceremony also ship today: `derive-calibration.sh` runs the five-dot ceremony to produce a firmware-versioned `calibration.json`, and `detect-marks.sh` per-turn emits structured JSON describing the marked state of each chrome checkbox (Finish-turn, End-session, and the mode-switch trio) across all pages via a capsule-area-threshold mark detector (stroke width times clipped centerline length), which handles both snap-to-straight chords and thick-marker single taps. Background polling wraps the detector: `poll-tablet.sh` spawns as a backgrounded process, uses `rmapi stat` (Version + ModifiedClient) to short-circuit idle iterations, pulls + detects only on cloud-side change, and emits `READY:<NN>` on stdout (with a `mode=<color|bw|wireframe>` suffix when the user flipped the radio-button mode-switch trio), `STOP:<NN>` when End-session is marked, or `ERROR:<context>:<details>` when a subprocess interaction fails persistently. Transient rmapi failures retry with per-operation exponential backoff (~30 s budget, `(2, 4, 8, 16)` s schedule); persistent failures emit one `ERROR:` line with suppression of identical repeats until a clean tick clears the state. The poller exits after one READY/STOP; the orchestrator respawns it with the next iter's `--cloud-doc` after pushing. The active mode is pre-filled into its checkbox at render time (chrome gold #a08020) and threaded across turns via `current_mode` in `design-state.md`'s frontmatter; B&W and Wireframe modes are wired as mode-specific stylesheets injected by render.mjs. `write-design-state.sh` performs the atomic per-turn frontmatter-update + iter-section replace-or-append + temp-write + rename, and `read-prefill.sh` provides cross-machine resume by pixel-sampling the cloud PDF's pre-filled mode-switch box to recover `current_mode` when local state is missing. Verify-before-push wraps the post-render / pre-push step: `verify-prompt.md` is the prompt template the orchestrator substitutes (`{NEW_PRERENDER_PATHS}`, `{PRIOR_PRERENDER_PATHS}` (literal `none` on iter 00 or when no prior pre-renders exist), `{USER_INTENT}`), `parse-verify-response.mjs` validates the subagent's `{verdict, reason}` JSON block (PASS implies empty reason, FAIL implies non-empty; unknown fields tolerated for forward compat), and on FAIL the orchestrator regenerates and re-renders up to 2 times; after 2 failed retries it pauses and asks the user "Push anyway, or abort?" (two options; default on timeout: push anyway), then either skips the push (abort) or pushes and surfaces the verifier's last reason in chat. Auth-bootstrap ships as a read-only verifier plus a PreToolUse hook: `check-rmapi-setup.sh` runs three checks (rmapi on PATH, conf valid via `rmapi -ni ls` exit status, hook installed in `~/.claude/settings.json`) without ever reading the conf directly, and `rmapi-conf-deny-hook.sh` blocks any tool dispatch whose Bash command, file path, or grep path contains the literal substring `rmapi.conf` (a companion `permissions.deny` rule was investigated and dropped 2026-05-17 after Claude Code's literal-substring matching was confirmed not to expand `$APPDATA`/`$HOME`, leaving the hook as the sole defense layer between Claude and the rmapi token). The full bootstrap dialogue now ships too: `check-poller-lock.sh` classifies `.tmp/sketch-brainstorm/poller.lock` as absent / stale / alive so the orchestrator can offer a force-claim prompt, `update-session-index.sh` + `render/session_index.py` maintain `.tmp/sketch-brainstorm/current-session.json` for the resume-vs-fresh / pick-older history list, and the design-language briefing primes `<repo-root>/.claude/sketch-brainstorm-mockup.css` on first run (auto-injected by `render.mjs` when present, chrome-only styling otherwise). Defense-in-depth wiring runs `check-rmapi-setup.sh` from inside `bootstrap-session.sh` as a precondition gate before any filesystem mutation, so the verifier executes on every session-start without relying on the user remembering to re-add the PreToolUse hook after a `~/.claude/settings.json` reset. What remains: compression (turn-by-turn rotation of design-state.md sections into archives) and multi-sketch iterations. See `SKILL.md` for current entry-points.

## Architecture (full design)

The full design is documented in the host project's feature backlog at `.claude/features/remarkable-tablet-brainstorm.md` (private to the Ring-O-Meter repo where this skill is being incubated). Key shape:

- **Transport**: `rmapi` (community CLI for reMarkable Cloud). USB tether is the documented escape hatch.
- **Render (outbound)**: Playwright drives Chrome via DevTools Protocol; pages target the Paper Pro viewport (1620x2160 px at 229 PPI, 7.08 x 9.43 inches at full bleed). rM2 owners see a small letterboxed margin.
- **Render (inbound)**: `rmapi get` pulls the turn's `.rmdoc` archive (zip with the source PDF + per-page `.rm` stroke files); `rmscene` parses the `.rm` files into vector stroke data; we render the strokes to SVG overlays at the same viewport dimensions as the rendered PDF. We do NOT use `rmapi geta` (its bundled `.rm` renderer trails the device firmware; recent v6 strokes fail with `Unknown header`). Going through `.rm` files directly gives clean vector data with exact device coordinates, no rasterisation noise, and no diff/subtract step.
- **Hand-off**: a fixed-position chrome footer on every rendered page hosts five checkboxes: Finish-turn (turn-boundary), End-session (session-boundary), and a Color / B&W / Wireframe mode-switch trio. A stroke-region detector (`detect-marks.sh`) inverse-transforms each registered checkbox's PDF rectangle into `.rm` coordinates using a firmware-versioned scale from `calibration.json`, then evaluates a capsule-area threshold (stroke width times clipped centerline length intersected with the box) to decide marked vs not, and emits a nested JSON `boxes` map per page keyed by box name with `area_rm_sq` + `marked`. The one-time calibration ceremony (`derive-calibration.sh`) pins the scale by asking the user to mark five reference dots. The polling wrapper (`poll-tablet.sh`) spawns as a backgrounded process via `Bash(run_in_background=true)`, watches the current iter's cloud doc via `rmapi stat`, pulls + detects on change, applies winner-takes-all to the mode-switch trio, and emits `READY:<NN>` (optionally with a `mode=<X>` suffix), `STOP:<NN>`, or `ERROR:<context>:<details>` on stdout. Transient rmapi failures retry with per-operation exponential backoff (~30 s); persistent failures emit one `ERROR:` line (suppressed on repeat, reset by a clean tick). The poller exits after one READY/STOP; the orchestrator respawns with the next iter's `--cloud-doc` after pushing.
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

- `rmapi` on `$PATH`. The skill assumes it is installed and authenticated; see [Installing rmapi for sketch-brainstorm](#installing-rmapi-for-sketch-brainstorm) below for the full setup including the security boundary.
- A host project with Playwright available. The skill resolves it from `skills/sketch-brainstorm/node_modules` (run `npm install` from the skill folder once) with a fallback to `$REPO_ROOT/web/node_modules` for in-repo incubation. Gist consumers: `npm install` in the skill folder.
- Chrome installed on the machine (the render uses `channel: 'chrome'` to mirror the host project's e2e suite).
- Python 3.10+ on `$PATH`. The inbound stroke-rendering pipeline (`render/render-strokes.py`) bootstraps a Python venv on first run inside the skill folder (`./.venv/`) and installs `rmscene` and any rendering helpers from `requirements.txt`. The venv keeps the Python deps self-contained alongside the skill rather than polluting the host machine's global Python.

## Installing rmapi for sketch-brainstorm

This skill assumes [rmapi](https://github.com/ddvk/rmapi) v0.0.33+ is installed and paired to your reMarkable account, and that Claude Code is configured with a PreToolUse hook that prevents Claude from reading the rmapi token by intercepting any tool call whose command, file path, or grep path contains the literal substring `rmapi.conf`. The hook defends against accidental access and an honest Claude acting on good-faith instructions. It does not defend against an adversarially-prompted Claude that first creates a symlink to the conf at a non-`rmapi.conf` path; that gap is a known accepted limitation documented in the project's QUICK_WINS tracker.

Why hook-only and not also a `permissions.deny` rule: Claude Code's deny patterns match the literal command/path string Claude writes, with no environment-variable expansion. A pattern like `Bash(*$APPDATA*rmapi*conf*)` blocks the unexpanded form (`cat $APPDATA/rmapi/rmapi.conf`) but lets the expanded form (`cat C:/Users/<you>/AppData/Roaming/rmapi/rmapi.conf`) fall through, which is the form Claude almost always writes. Verified empirically 2026-05-17 by installing a marker-based deny-rule and observing the expanded path run unblocked. The hook's regex match on `rmapi.conf` is OS-agnostic and covers both forms, so adding a partly-effective deny-rule on top would just be cosmetic defense-in-depth.

### 1. Pair rmapi

Run in your terminal:

```bash
rmapi help
```

On an unpaired machine, rmapi prompts for a one-time activation code from <https://my.remarkable.com/device/desktop/connect>. On a paired machine it prints usage. The resulting conf lives at the OS default:
- **Windows**: `%APPDATA%\rmapi\rmapi.conf`
- **macOS/Linux**: `~/.config/rmapi/rmapi.conf` *(presumed XDG default - please verify on first non-Windows machine and let us know if it differs)*

**Destructive-rotation caveat:** rmapi v0.0.33 zeroes both tokens in its conf to `""` on a failed authentication attempt. If you are deliberately rotating a token (not just re-pairing after expiry), back the existing conf up first: a typo in the activation code leaves the conf un-paireable until you restore the backup. Routine re-pairs after an expiry do not need this - the conf is already invalid.

### 2. Install the PreToolUse hook

Open `~/.claude/settings.json`. If it does not exist, create it from the snippet below. If it exists with other entries, **merge** the `hooks.PreToolUse` array (do not replace it):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Read|Edit|Write|NotebookEdit|Grep",
        "hooks": [
          {
            "type": "command",
            "command": "bash $HOME/.claude/skills/sketch-brainstorm/rmapi-conf-deny-hook.sh"
          }
        ]
      }
    ]
  }
}
```

**Hook-path variant for in-repo incubation:** while the skill lives inside a host repo (this repo, `skills/sketch-brainstorm/`), use:

```json
"command": "bash <absolute-path-to-repo>/skills/sketch-brainstorm/rmapi-conf-deny-hook.sh"
```

### 3. Verify

Run:

```bash
bash <skill-path>/check-rmapi-setup.sh
```

It prints one `[PASS]` / `[FAIL]` / `[ERROR]` line per check and exits 0 if all three pass. Exit codes: 0 = all pass; 1 = at least one check fails (actionable install gap); 2 = structural prerequisite error (jq missing, settings.json malformed).

## rmapi quirks observed in practice

- **Every non-interactive rmapi invocation in this skill passes the global `-ni` flag.** Without `-ni`, rmapi defaults to interactive re-pair prompts on auth failure ("Enter one-time code (go to https://my.remarkable.com/device/browser/connect):"); in a closed-stdin subprocess on Windows Git Bash, that prompt loops indefinitely on empty reads from `/dev/null`, spamming `Code has the wrong length, it should be 8` and consuming arbitrary disk/memory until the parent kills it (verified 2026-05-16: ~250 MB of stderr in seconds). With `-ni`, rmapi aborts fast on an expired token with verbatim stderr `ERROR: <timestamp> auth.go:30: missing token, not asking, aborting` -- which `poll_tablet.py`'s `AUTH_EXPIRED_STDERR_PATTERNS` matches as `"missing token, not asking, aborting"`. The fail-fast path also lets the poller surface a clean `ERROR:auth-expired:...` line to main chat instead of hanging the polling tick. Diagnostic messages that *suggest* the user run `rmapi ls` themselves stay as plain `rmapi ls` -- that's the user-facing interactive re-pair surface and interactivity is desired there. `setup-rmapi.sh` (future slice) is the only place where prompt mode is intentional. Verification: edit RMAPI_CONFIG to point at a sandbox conf with a JWT-shaped bogus token; rmapi destructively blanks the token to `""` after the failed call, so never run this probe against the real conf at `$HOME/.config/rmapi/rmapi.conf` (Linux/Mac) or `%APPDATA%/rmapi/rmapi.conf` (Windows).
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
- `package.json` -- skill-local npm manifest; declares `playwright` dep so gist consumers can `npm install` in the skill folder.
- `vocabulary.md` -- canonical core vocabulary table.
- `render/page-template.html` -- HTML template with token placeholders.
- `render/page-chrome.css` -- chrome-zone styles (header, notes, legend, checkboxes).
- `render/page-chrome-bw.css` -- B&W mode stylesheet, injected by render.mjs when `--current-mode bw`.
- `render/page-chrome-wireframe.css` -- Wireframe mode stylesheet, injected by render.mjs when `--current-mode wireframe`.
- `render/render.mjs` -- Node ESM script that drives Chromium and writes the PDF.
- `render-html-to-pdf.sh` -- bash wrapper for the outbound PDF render pipeline.
- `push-to-tablet.sh` -- bash wrapper for the rmapi push (outbound cloud upload).
- `pull-from-tablet.sh` -- bash wrapper for `rmapi get` + `.rmdoc` extraction (inbound cloud download).
- `poll-tablet.sh` -- bash wrapper for the background polling daemon; emits `READY:<NN>` (optionally with `mode=<X>` suffix), `STOP:<NN>`, or `ERROR:<context>:<details>` on stdout.
- `render/poll_tablet.py` -- polling daemon implementation; lock file with heartbeat, `rmapi stat`-driven change detection, per-operation exponential backoff with ERROR emission and repeat-suppression, detector dispatch. Key exports: `classify_subprocess_error`, `_run_with_retry`, `BACKOFF_SLEEPS`, `_CLASSIFIED_ERRORS`, `_STAGE_*` constants.
- `render/test_poll_tablet.py` -- unit tests for the poller (stdlib-only, no venv needed); covers lock, signature comparison, poll-once branching, mode-winner resolution, run() lifecycle, ERROR classification table, retry backoff, ERROR suppression and reset.
- `detect-marks.sh` -- bash wrapper for the per-turn checkbox detector; emits structured JSON keyed by box name.
- `render/detect_marks.py` -- capsule-area mark detector; reports per-box `area_rm_sq` + `marked` across all pages.
- `render/_chrome_boxes.py` -- dependency-free shared data module: BOX_REGISTRY (5-box PDF coordinates), VALID_MODES, ITER_NN_RE. Importable from both venvs.
- `render/_geometry.py` -- capsule-area geometry primitives; stdlib-only (math only). Extracted so test_geometry.py runs without the venv.
- `render/_atomic_write.py` -- atomic_write_text helper (write-to-temp + os.replace); shared by poll_tablet and write_design_state.
- `render/_calibration.py` -- calibration file management: SKILL_ROOT, CALIBRATION_JSON, CALIBRATION_SCHEMA_VERSION, CalibrationError, load_calibration; stdlib-only (no rmscene dependency).
- `render/_test_helpers.py` -- shared kebab-module load harness used by test_composite_annotated.py and test_render_strokes.py; stdlib-only.
- `render/_rm_strokes.py` -- shared .rm parser and manifest reader: PAGE_W/PAGE_H, PEN_COLORS, collect_lines, ManifestError, manifest_pages (dual-schema), ordered_rm_files (rendering order, delegates to manifest_pages).
- `render/test_detect_marks.py` -- unit tests for the detector (stdlib-only with rmscene stubbed).
- `render/test_geometry.py` -- unit tests for capsule-area geometry helpers; stdlib-only (imports _geometry.py directly; no venv or rmscene stub required).
- `write-design-state.sh` -- bash wrapper for the atomic design-state.md update (frontmatter + iter-section replace-or-append + write-temp + rename).
- `render/write_design_state.py` -- implementation of the atomic write helper; includes a pre-write integrity check that rejects pre-existing duplicate `## Iteration NN` headings (silent-corruption guard for external file mutation).
- `render/test_write_design_state.py` -- unit tests for write-design-state (stdlib-only).
- `read-prefill.sh` -- bash wrapper for the cross-machine resume helper; pixel-samples the cloud PDF's pre-filled mode-switch box and prints the active mode.
- `render/read_prefill.py` -- implementation of read-prefill (venv-required: PyMuPDF + Pillow).
- `render/test_read_prefill.py` -- unit tests for read-prefill (venv-required).
- `rmapi-conf-deny-hook.sh`: PreToolUse hook implementation that blocks tool calls referencing the literal filename `rmapi.conf`. Reads tool-call JSON on stdin (extracts `tool_name`, `command`, `file_path`, `path`), regex-matches case-insensitively, exits 2 with audit-log entry on match, exits 0 silent on no-match, exits 0 fail-open on malformed JSON. Audit log at `~/.claude/sketch-brainstorm-conf-access.log` (override via optional positional arg `$1`, used by tests; production callers pass no args and get the default). Never invoked directly by Claude; wired via `~/.claude/settings.json`.
- `test.sh` -- bash wrapper that runs the Python test suite (via the skill venv) followed by the Node test suite (`test_*.mjs`). `bash test.sh` runs both; pass `test_<module>` or a dotted test id to target a Python subset.
- `_lib.sh` -- internal bash helpers sourced by other wrappers: rmapi auth precondition, shared Python venv bootstrap with requirements.txt drift detection, and `find_repo_root <start-dir>` (walk-upward `Ring-O-Meter.slnx` marker discovery; sourced by `render-html-to-pdf.sh` with `$SCRIPT_DIR` and by `bootstrap-session.sh` with `$PWD`).
- `render/render-strokes.py` -- converts per-page `.rm` stroke files to SVG overlays.
- `render-strokes.sh` -- bash wrapper for the inbound stroke-rendering pipeline.
- `render/composite-annotated.py` -- composites stroke SVGs onto PDF pages as PNGs (uses PyMuPDF + Pillow).
- `composite-annotated.sh` -- bash wrapper for the composite step.
- `render/prerender-pages.py` -- PyMuPDF-based PDF-to-PNG rasterizer; invoked by `render-html-to-pdf.sh`'s `--prerender-out` flag.
- `bootstrap-session.sh` -- creates the per-session local folder skeleton and primes `design-state.md` (including `current_mode: color` frontmatter); idempotent. Invokes `check-rmapi-setup.sh` as a defense-in-depth precondition before any filesystem mutation, and registers the new session as active in `current-session.json` via `update-session-index.sh add`.
- `update-session-index.sh` -- bash wrapper around `session_index.py`; subcommands `add` (called by `bootstrap-session.sh`), `set-active` (called by the orchestrator's resume / pick-older branches in the full bootstrap dialogue), and `increment-turn` (called by the iter01+ loop body after each successful push).
- `render/session_index.py` -- read / write `.tmp/sketch-brainstorm/current-session.json`: `read_index`, `add_session` (idempotent on session_dir), `set_active`, `increment_turns`, `SessionIndexError`. Atomic writes via `_atomic_write`.
- `test_update_session_index.sh` -- bash test for the wrapper (subcommand routing, repo-root resolution, error paths, increment-turn cumulative + negative).
- `render/test_session_index.py` -- unit tests for the index library (add idempotency, active-pointer demotion, increment_turns cumulative + negative, malformed-JSON handling).
- `check-poller-lock.sh` -- bash wrapper that prints one JSON line on stdout classifying `.tmp/sketch-brainstorm/poller.lock` as `absent`, `stale`, or `alive`. Always exits 0; lock states are data, not errors.
- `render/check_poller_lock.py` -- read-only lock classifier: `check_lock(path)` returns a dict with `status` plus supporting fields (pid, heartbeat_age_s, reason). PID-alive uses `os.kill(pid, 0)`; heartbeat staleness threshold is 60 s to tolerate one missed iteration at the 30 s poll cadence.
- `test_check_poller_lock.sh` -- bash test for the wrapper (JSON parse, repo-root override, exit-0 invariant).
- `render/test_check_poller_lock.py` -- unit tests for `check_lock` covering absent / alive / stale-pid-dead / stale-heartbeat / stale-malformed branches.
- `check-rmapi-setup.sh`: read-only three-check verifier (rmapi on PATH, conf valid, PreToolUse hook installed). Exit 0/1/2 with rationale. Safe for Claude to invoke on demand. See "Installing rmapi for sketch-brainstorm" above and the design rationale in `.claude/features/remarkable-tablet-brainstorm.md` (Transport section).
- `parse-interpret-json.mjs` -- shell-callable JSON parse + validate helper for the interpret subagent's response.
- `parse-verify-response.mjs` -- shell-callable JSON parse + validate helper for the verify subagent's response (`{verdict, reason}` with asymmetric-reason rule + forward-compat unknown-field tolerance).
- `render/test_composite_annotated.py` -- unit tests covering: page-pattern regex and numeric sort (`composite-annotated.py`); resolution-constants invariant between composite and prerender-pages modules; `collect_lines` single-point-stroke contract (`_rm_strokes.py`).
- `render/test_render_strokes.py` -- unit tests covering: PAGE_W/PAGE_H parity between render-strokes and composite-annotated; `main()` calibration-present and auto-fit branches (`render-strokes.py`); stdlib-only (rmscene stubbed).
- `render/test_calibration.py` -- unit tests for `_calibration.py` schema validation: rejects unknown version, rejects missing-schema (implied v1), accepts current version; stdlib-only.
- `render/test_prerender_pages.py` -- end-to-end test for `prerender-pages.py` against a real two-page PDF.
- `render/test_render_format.mjs` -- node:test cases for `formatIterationLabel`.
- `render/test_project_css_injection.mjs` -- node:test cases for the `--project-mockup-css` CLI flag plumbing through `render.mjs`'s `parseArgs`.
- `test_interpret_parse.mjs` -- node:test cases for `parseInterpretResponse`.
- `test_verify_parse.mjs` -- node:test cases for `parseVerifyResponse` (12 cases including PASS/FAIL happy paths, the asymmetric-reason rule both directions, CRLF, chatty preamble, no-fence, malformed JSON, missing fields, wrong-cased verdict, unknown-field tolerance).
- `test_bootstrap_session.sh` -- bash test for `bootstrap-session.sh`.
- `test_check_rmapi_setup.sh`: standalone bash test runner for `check-rmapi-setup.sh`. Not wired into `test.sh` (which handles Python + Node only); run manually with `bash skills/sketch-brainstorm/test_check_rmapi_setup.sh`.
- `test_rmapi_conf_deny_hook.sh`: standalone bash test runner for `rmapi-conf-deny-hook.sh`. Not wired into `test.sh`; run manually.
- `interpret-prompt.md` -- prompt template for the interpretation subagent. Read by the orchestrator (Claude in main chat); not directly executable.
- `verify-prompt.md` -- prompt template for the verify-before-push subagent. Read by the orchestrator; substituted tokens are the new + prior pre-render PNG paths plus the turn's `user_intent`.
- `requirements.txt` -- Python deps for the inbound pipeline (rmscene + pymupdf + Pillow).

The intended gist layout is a mechanical mirror of this directory tree.

# Verify subagent prompt

Template for dispatching a fresh verify subagent between local render and
cloud push. The orchestrator (Claude in main chat) substitutes the
bracketed tokens, dispatches via the Agent tool with
`subagent_type: general-purpose`, and parses the returned JSON block
(`verdict`, `reason`) to decide PASS (proceed to push) or FAIL (regenerate
and re-render up to a retry budget).

The subagent is fresh per dispatch (no reused agent). All multimodal raster
data lives in the subagent's context; the parent receives only the
verdict + short reason. This isolation keeps the parent context lean
across many iterations.

## Tokens

- `{NEW_PRERENDER_PATHS}`: newline-bullet list of absolute paths to the
  pre-render PNGs for the current turn (one per rendered page). Produced
  by `render-html-to-pdf.sh --prerender-out`.
- `{PRIOR_PRERENDER_PATHS}`: newline-bullet list of absolute paths to the
  prior turn's pre-render PNGs, or the literal string `none` when no
  prior turn exists (iter 00, or iter 01 if iter 00 pre-renders are not
  available). The literal `none` switches the verifier into
  absolute-layout-sanity-only mode.
- `{USER_INTENT}`: this turn's user_intent text. For iter 00, this is
  either the user's initial description verbatim (description-driven
  sub-path) or the literal string
  `(blank page; no specific intent; absolute layout-sanity only)`
  (blank-page sub-path).

## Prompt body

````
You are a visual sanity check between a rendered UI mockup and the
change request that produced it. Your job is to spot rendering
failures that would waste the user's time if pushed to the tablet,
without being so picky that every minor aesthetic quibble triggers a
re-render.

## Inputs

New pre-renders (this turn's rendered pages):

{NEW_PRERENDER_PATHS}

Prior pre-renders (last turn's rendered pages, for differential check):

{PRIOR_PRERENDER_PATHS}

User intent for this turn:

{USER_INTENT}

## What to check

Always (absolute layout sanity, regardless of prior renders):

- Text overflow: text spilling outside its container.
- Off-canvas elements: content positioned outside the visible page.
- Missing chrome zones: header strip, notes region, or footer
  rendered blank or absent when they should be present.
- Literal `{{token}}` strings visible in the output (template
  substitution typo).
- Stack traces, raw error blobs, or HTML/CSS source visible in the
  rendered output.

When prior renders are supplied (differential check):

- Did the change requested in user_intent visually manifest?
  Examples: "make the cancel button bigger" should produce a visibly
  larger cancel button; "swap the rows" should produce swapped rows;
  "remove the legend" should produce a page with the legend gone.
- If the requested change is not visible, that is a FAIL; name the
  specific change that failed to land.

## What NOT to check

These are out of scope. Flagging them produces wasted re-renders
without coaching value:

- Design-language drift: off-brand colors, typography choices,
  spacing preferences. The user annotates these on the next turn.
- Fidelity inside a faithfully-rendered component: if a button is
  rendered as a button with the right label in roughly the right
  place, that is enough. Do not nitpick exact pixel positioning,
  shadow depth, border-radius values, etc.
- Anything the user could easily annotate on the next turn. If a
  human reviewer would say "fine, I'll just circle that and move
  on," it is not a verify-stage failure.

## Response format

Return EXACTLY one fenced JSON block. No preamble, no postscript, no
explanation outside the block.

On PASS:

```json
{"verdict":"PASS","reason":""}
```

On FAIL:

```json
{"verdict":"FAIL","reason":"<one sentence naming the specific failure mode>"}
```

The `reason` field is empty on PASS and non-empty on FAIL. Do not
add commentary on PASS; do not return FAIL without naming the
specific failure.
````

## How the orchestrator uses this

1. Read this prompt template, substitute the tokens, dispatch via the
   Agent tool with `subagent_type: general-purpose`. The subagent
   reads the PNGs itself via its own Read tool.

2. The subagent returns one fenced JSON block with `verdict` and
   `reason`. Pipe the raw response through
   `node parse-verify-response.mjs` (stdin = raw response) to extract
   and validate.

3. On PASS: proceed to push.

4. On FAIL: regenerate `mockups/<slug>-NN.html` with the verifier's
   reason added as a constraint, re-render, re-verify. Retry budget:
   2 re-renders per turn. After 2 failed verifies, push anyway and
   surface the verifier's last reason verbatim in chat with the
   caveat:
   "verifier flagged: <reason> - 2 retries did not resolve it; check
   on the tablet."

5. On parse failure (parse-verify-response.mjs exits non-zero):
   retry the dispatch once with a "JSON only, no preamble; conform to
   the contract" reminder appended; on a second parse failure, surface
   the raw response with the caveat "verifier returned malformed
   output twice; proceeding to push without verify-gate." and proceed
   to push. Parse failures do NOT consume the FAIL retry budget in
   step 4.

The canonical orchestrator-side state machine lives in SKILL.md's
"Verify entry point" section. The steps above are the dispatch
shape; SKILL.md is authoritative for the full retry/parse-failure
semantics.

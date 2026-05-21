# Interpretation subagent prompt

Template for dispatching a fresh interpretation subagent on a turn's
annotated composite PNGs. The orchestrator (Claude in main chat)
substitutes the bracketed tokens, dispatches via the Agent tool with
`subagent_type: general-purpose`, and parses the returned JSON block
(`user_intent`, `design_state_delta`, `per_page_observations`) to
drive the next iteration.

The subagent is fresh per turn (no reused agent). All multimodal raster
data lives in the subagent's context; the parent receives only the
distilled text. This isolation is load-bearing: it keeps the parent
context lean across many iterations and prevents prior-turn pixel data
from biasing the next interpretation.

## Tokens

- `{COMPOSITE_PATHS}`: newline-bullet list of absolute paths to the
  annotated composite PNGs, one per annotated page. Produced by
  `composite-annotated.sh`.
- `{VOCAB_PATH}`: absolute path to `vocabulary.md` (the global
  gesture vocabulary). Project-local extension at
  `.claude/sketch-on-tablet-vocab.md` should be appended to the list
  if present.
- `{TOPIC}`: the current session's topic (one short phrase the user
  set when launching the brainstorm). Helps the subagent disambiguate
  intent against an existing context.

If a token has no value for the current call (e.g., no project-local
vocab extension), drop the line entirely; do not leave the literal
`{TOKEN}` in the dispatched prompt.

## Prompt body

````
You are interpreting a user's pen annotations on a UI mockup. The user
sketched on a reMarkable tablet to give feedback on the current
iteration; your job is to distill what they want for the next
iteration into a structured JSON block: a short `user_intent`
summary, a `design_state_delta` body of markdown for the design
log, and `per_page_observations` for debugging. See "Output format"
below for the exact schema.

## Session topic

{TOPIC}

## Inputs

Read each of these composite PNGs (mockup + user's strokes overlaid)
in order. Each represents one annotated page of the iteration:

{COMPOSITE_PATHS}

Read the gesture vocabulary:

- {VOCAB_PATH}

## Page regions

Each rendered page has distinct regions and the interpretation rules
differ by region. Visually distinguish them from the page chrome:

- **Mockup region** (page 1 only): the bounded canvas where the
  rendered mockup lives, between the header strip and the small
  notes region below it. Strokes here are about something on the
  mockup; the geometric attribution heuristic always finds a target.
  The mockup region has no "margin" interpretation - even strokes
  over apparently empty mockup space attribute to the nearest
  element, or to the canvas as a whole when the mockup is genuinely
  empty.
- **Notes region** (page 1 small notes; page 2 larger notes; any
  user-added pages 3+): the bounded ruled-line areas below the
  mockup or legend. These are free-form annotation areas. Content
  is typically handwritten text reading as an instruction for
  Claude; drawings are also valid here, usually because a sketch
  did not fit in the mockup viewport. The vocabulary's geometric
  gesture rules do NOT apply in the notes region: an "X" or a
  circle drawn in notes is a free-form sketch, not a Remove or Add
  gesture.
- **Anomalous regions**: the header strip (topic + iter label up
  top), the chrome footer (excluding the Finish-turn checkbox, which
  is the only expected user input in the chrome), and the page-2
  legend region (the rendered vocabulary cheat-sheet). User strokes
  here are unusual; flag as anomalies and do not infer structural
  intent from them.

The bridging case is the **letter callout** vocabulary entry: a
letter callout (`a:`, `b:`, ...) drawn near a mockup-region element
plus a matching `a.`/`b.`-prefixed note in *any* notes region links
the long-form note to that specific element. The matching note may
sit in the same page's notes region OR in any user-added notes-only
page (3+); letter callouts are unique within an iteration, so a
single matching note across all notes regions resolves the pair.
Treat the pair as one intent unit attributed to the called-out
element.

## Task

Identify each stroke cluster on each page, locate which region it
falls in, and apply the region-appropriate interpretation rule.
Compose the per-cluster intents into the three output fields
described in "Output format" below: a short `user_intent`, a
`design_state_delta` body, and `per_page_observations`.

## Reasoning approach

1. Read the vocabulary first; you'll consult it for gestures in the
   mockup region.
2. Read each composite PNG. Identify the page regions visually
   (header strip, mockup or legend, notes, chrome footer) before
   listing strokes.
3. For each stroke cluster, locate which region it falls in.
4. **Mockup-region clusters**: name the gesture per the vocabulary
   and attribute to the nearest UI element via bounding-box
   overlap, with nearest-edge distance as tiebreak. The mockup
   region has no margin: every stroke has a target (specific
   element when one is nearby, or the canvas as a whole when the
   mockup is empty).
5. **Notes-region clusters**: transcribe handwritten text verbatim;
   describe non-text drawings briefly. Treat as instruction for
   Claude. Letter-prefixed notes (`a.`, `b.`) link to matching
   letter callouts in the mockup region (possibly on a different
   page; see "Page regions" above for the bridging rule); pair them
   and attribute to the called-out element.
6. **Anomalous-region strokes** (header, chrome footer except the
   Finish-turn checkbox, page-2 legend): flag as anomalies; the
   user does not normally annotate these regions.
7. Synthesize the per-cluster intents into the three output fields
   described in "Output format" below: a short `user_intent`, a
   `design_state_delta` body, and `per_page_observations`.

## Failure modes

- **Spatial ambiguity** (mockup region): a cluster could attach to
  more than one element. Pick the nearer one and name the ambiguity
  in your output (e.g., "Arrow between upper and lower button could
  mean swap or 'make upper match lower'; rendering as swap. Correct
  on next iteration if wrong.").
- **Vocabulary mismatch** (mockup region only): a gesture in the
  mockup region matches no vocabulary entry. Describe what was
  drawn in the user_intent and infer no structural change. Do not
  invent meaning. Notes-region content is never vocabulary-matched
  in the first place, so this failure mode does not apply there.
- **Contradictory strokes**: e.g., a strikethrough plus a "make
  larger" arrow on the same element. Best-effort merge ("remove and
  replace with a larger version") and name the contradiction.
- **Missing intent**: a page has no annotations or only stray marks.
  Say so explicitly; do not infer changes that weren't drawn.
- **Anomalous strokes** (header / footer / legend): surface as
  observations, but do not invent structural intent from them.
- **Orphaned letter callout / orphaned letter note**: a letter
  callout in the mockup region with no matching `a.`-prefixed note
  anywhere (or vice versa: an `a.`-prefixed note with no matching
  callout). Treat the orphaned half as the non-letter form of the
  same gesture: an orphaned callout reads as a regular handwritten
  label on the called-out element; an orphaned `a.` note reads as
  a free-form notes-region instruction with the letter prefix
  preserved verbatim. Surface the orphaning in `user_intent` so
  the user can supply the missing half on the next iteration.

Do NOT silently resolve ambiguity, and do NOT introduce intent beyond
what was annotated. The user disambiguates on the next iteration if
your reading was wrong; that loop only works if you flag the
ambiguity rather than pick silently.

## Output format

Return EXACTLY one fenced JSON block. No preamble, no postscript, no
explanation outside the block.

```json
{
  "user_intent": "...",
  "design_state_delta": "...",
  "per_page_observations": ["page 1: ...", "page 2: ..."]
}
```

`user_intent`: 1-3 sentences in plain prose, addressed to the
person composing the next iteration (e.g., "user wants the cancel
button larger and moved closer to save; the dim slider should ramp
continuously rather than in tick-marks").

`design_state_delta`: body markdown only (paragraphs, lists, links)
describing what was decided in this turn. Do NOT emit a heading; the
orchestrator wraps the body with `## Iteration NN` before appending
to design-state.md. Keep under ~300 words.

`per_page_observations`: array of one-line observations, one per
rendered page that was annotated. Skip pages without annotations.
This field is informational; the orchestrator surfaces it for
debugging and discards after the next iteration ships.
````

## How the orchestrator uses this

1. Run the inbound chain to produce composite PNGs:
   ```
   STROKES_DIR="$(bash skills/sketch-on-tablet/pull-from-tablet.sh \
     --cloud-doc <path> --out-dir <out>)"
   bash skills/sketch-on-tablet/render-strokes.sh "$STROKES_DIR" <svgs>
   bash skills/sketch-on-tablet/composite-annotated.sh \
     --pdf "$(dirname "$STROKES_DIR")/$(basename "$STROKES_DIR").pdf" \
     --strokes-dir <svgs> --out-dir <composites>
   ```

   Note the `--pdf` path: the source PDF sits one level above the
   rm-dir as `<extract-dir>/<doc-uuid>.pdf` (see README rmapi quirks).

2. Read this prompt template, substitute the tokens, dispatch via the
   Agent tool with `subagent_type: general-purpose`. Pass the
   per-call topic + composite paths in the prompt; the subagent reads
   the PNGs and vocabulary itself via its own Read tool.

3. The subagent returns one fenced JSON block with `user_intent`,
   `design_state_delta`, and `per_page_observations`. The orchestrator
   parses the block, consumes `user_intent` as the input to the next
   iteration's render, appends `design_state_delta` to design-state.md
   wrapped under an `## Iteration NN` heading, and surfaces
   `per_page_observations` for debugging before discarding after the
   next iteration ships.

## Future expansion

Slices still ahead of this prompt:

- A `{DESIGN_STATE}` token carrying the `design-state.md` head, so
  the subagent has prior-iteration context.
- A `slug_suggestion` field (consumed by the bootstrap-dialogue
  slice). Shipping it ahead would freeze the schema before its
  consumer exists.

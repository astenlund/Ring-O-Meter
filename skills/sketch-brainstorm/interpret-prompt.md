# Interpretation subagent prompt

Template for dispatching a fresh interpretation subagent on a turn's
annotated composite PNGs. The orchestrator (Claude in main chat)
substitutes the bracketed tokens, dispatches via the Agent tool with
`subagent_type: general-purpose`, and consumes the returned
`user_intent` text for the next iteration.

The subagent is fresh per turn (no reused agent). All multimodal raster
data lives in the subagent's context; the parent receives only the
distilled text. This isolation is load-bearing: it keeps the parent
context lean across many iterations and prevents prior-turn pixel data
from biasing the next interpretation.

## Tokens

- `{COMPOSITE_PATHS}` — newline-bullet list of absolute paths to the
  annotated composite PNGs, one per annotated page. Produced by
  `composite-annotated.sh`.
- `{VOCAB_PATH}` — absolute path to `vocabulary.md` (the global
  gesture vocabulary). Project-local extension at
  `.claude/sketch-brainstorm-vocab.md` should be appended to the list
  if present.
- `{TOPIC}` — the current session's topic (one short phrase the user
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
iteration into 1-3 sentences of plain English.

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
Compose the per-cluster intents into one short summary describing
what the user wants in the next iteration.

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
7. Synthesize the per-cluster intents into one user_intent
   paragraph.

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

## Output

Return your response in this exact structure:

```
## Per-page observations

- Page 1: <one or two sentences naming the strokes and their
  attribution>
- Page 2: <same>
- ... (one bullet per composite PNG read)

## user_intent

<1-3 sentences. This is what the parent uses to drive the next
iteration. Lead with the strongest, clearest change. Name any
ambiguities or vocabulary mismatches inline.>
```

Keep the per-page observations terse; their job is to expose your
attribution decisions for human review, not to re-describe the
mockup. The user_intent paragraph is the load-bearing output.
````

## How the orchestrator uses this

1. Run the inbound chain to produce composite PNGs:
   ```
   STROKES_DIR="$(bash skills/sketch-brainstorm/pull-from-tablet.sh \
     --cloud-doc <path> --out-dir <out>)"
   bash skills/sketch-brainstorm/render-strokes.sh "$STROKES_DIR" <svgs>
   bash skills/sketch-brainstorm/composite-annotated.sh \
     --pdf "$(dirname $STROKES_DIR)/$(basename $STROKES_DIR).pdf" \
     --strokes-dir <svgs> --out-dir <composites>
   ```

   Note the `--pdf` path: the source PDF sits one level above the
   rm-dir as `<extract-dir>/<doc-uuid>.pdf` (see README rmapi quirks).

2. Read this prompt template, substitute the tokens, dispatch via the
   Agent tool with `subagent_type: general-purpose`. Pass the
   per-call topic + composite paths in the prompt; the subagent reads
   the PNGs and vocabulary itself via its own Read tool.

3. The subagent returns text containing per-page observations and a
   `user_intent` paragraph. The orchestrator extracts the
   `user_intent` and consumes it as the input to the next iteration's
   render. Per-page observations are kept for the user to spot-check
   if a turn went sideways, then discarded after the next iteration
   ships.

## Future expansion

When the iter01+ loop and design-state.md slices land, this prompt
gains:

- A `{DESIGN_STATE}` token carrying the `design-state.md` head, so
  the subagent has prior-iteration context.
- A structured JSON output schema (`user_intent`,
  `design_state_delta`, `slug_suggestion`) replacing the
  text-only shape above. The text shape is the v1 MVP.

Don't pre-build the JSON shape now: the iter01+ slice is the only
consumer of `design_state_delta` and the bootstrap-dialogue slice is
the only consumer of `slug_suggestion`. Shipping them ahead would
freeze the schema before its consumers exist.

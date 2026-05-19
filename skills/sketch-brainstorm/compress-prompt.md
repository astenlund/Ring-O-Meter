# Compression subagent prompt

Template for dispatching a fresh compression subagent after a successful
push, when the trigger check (`check-compression-needed.sh`) reports
`trigger: true`. The orchestrator (Claude in main chat) substitutes the
bracketed tokens, dispatches via the Agent tool with
`subagent_type: general-purpose` and `run_in_background: true`, and on
completion parses the returned JSON block (`archive_content`,
`new_active_head_content`) to validate and apply the write via
`write-archive.sh`.

The subagent is fresh per dispatch and runs in the background so the
loop body's user-visible cadence is not gated on summarization. Prior
archive paths are passed in so the subagent can maintain coherence across
the chain.

## Tokens

- `{ACTIVE_HEAD_PATH}`: absolute path to the session's current
  `design-state.md`. The subagent reads it directly via its Read tool.
- `{TURNS_TO_ARCHIVE}`: comma-separated zero-padded turn numbers (e.g.,
  `00,01,02,03,04`). The subagent must summarize exactly these turns
  into `archive_content` and remove their `## Iteration NN` sections
  from `new_active_head_content`.
- `{TURNS_TO_KEEP}`: comma-separated zero-padded turn numbers (e.g.,
  `05,06,07,08,09,10`). The subagent must preserve these iteration
  sections verbatim in `new_active_head_content`.
- `{PRIOR_ARCHIVES}`: newline-bullet list of absolute paths to prior
  archive files in order (oldest first), or the literal string `none`
  on first compression. When non-empty, the subagent reads each prior
  archive to maintain coherence with earlier summaries.
- `{ARCHIVE_NNN}`: three-digit sequence number this archive will receive.
  The subagent MAY include `archive-id: NNN` in the archive frontmatter
  using this value. The number is advisory: `write-archive.sh` re-resolves
  the actual sequence at write time, so if a concurrent compression
  completed between trigger-check and write, the on-disk filename may
  differ from this value.
- `{CREATED_TIMESTAMP}`: ISO 8601 UTC timestamp for the archive's
  `created:` frontmatter field (the orchestrator supplies this so all
  archives share the orchestrator's clock).

## Prompt body

````
You are compressing older turns of a sketch-brainstorm session's
design-state.md into an immutable archive entry. Your job is to:

1. Summarize the named older turns into a single archive file.
2. Produce a replacement design-state.md that drops those turns but
   preserves the frontmatter and the kept turns verbatim.

## Inputs

Active head (read this file via your Read tool):

  {ACTIVE_HEAD_PATH}

Prior archive files (read these via your Read tool for context):

  {PRIOR_ARCHIVES}

Turns to archive (summarize these into archive_content):

  {TURNS_TO_ARCHIVE}

Turns to keep (preserve verbatim in new_active_head_content):

  {TURNS_TO_KEEP}

Archive sequence number (for optional archive-id frontmatter field):

  {ARCHIVE_NNN}

Archive creation timestamp (use this verbatim in the frontmatter):

  {CREATED_TIMESTAMP}

## What to produce

### archive_content

A markdown document starting with a YAML frontmatter block, followed
by a coherent prose summary of the archived turns. The frontmatter
MUST include at minimum:

  ---
  turn-range: <first>-<last>      # e.g., 00-04
  created: {CREATED_TIMESTAMP}    # use the timestamp value from the Inputs section above
  ---

Body: a coherent narrative summary of what the user decided and what
the design evolved into over the archived span. Preserve concrete
decisions and rejected alternatives that bear on later turns; drop
intermediate exploration that the decisions superseded. Aim for a
length proportional to the span being archived (a few hundred words
for a 5-turn span). If prior archives exist, write the summary so it
flows continuously with them when read in sequence.

### new_active_head_content

The full replacement text of design-state.md. Preserve the existing
frontmatter block exactly (including `slug`, `topic`, `created`,
`current_mode`). After the frontmatter, include ONLY the `## Iteration
NN` sections for the kept turns, copied VERBATIM from the active head.
Do not paraphrase, reorder, or modify the kept sections. The archived
turn headings and bodies must be absent.

## Response format

Return EXACTLY one fenced JSON block. No preamble, no postscript,
no explanation outside the block.

```json
{
  "archive_content": "---\nturn-range: 00-04\ncreated: 2026-05-19T15:00:00Z\n---\n\n(your summary body)\n",
  "new_active_head_content": "---\nslug: foo\ntopic: bar\n...\n---\n\n## Iteration 05\n\n(verbatim)\n\n..."
}
```

Both fields are required and non-empty strings, and both must start
with `---\n` (the YAML frontmatter block): `archive_content`'s
frontmatter is the new archive's own; `new_active_head_content`'s
frontmatter is the existing design-state.md frontmatter preserved
verbatim.
````

## How the orchestrator uses this

1. Read this prompt template, substitute the tokens, dispatch via the
   Agent tool with `subagent_type: general-purpose` and
   `run_in_background: true`. The subagent reads the files itself via
   its own Read tool.

2. The subagent returns one fenced JSON block with `archive_content`
   and `new_active_head_content`. Pipe the raw response through
   `node parse-compress-response.mjs` (stdin = raw response) to extract
   and validate.

3. On parse success, invoke
   `bash write-archive.sh --session-dir <session> --turns-to-archive <list> --turns-to-keep <list>`
   with the parsed JSON on stdin. The wrapper performs the structural
   invariant check (archived turns absent from new head; kept turns
   present) and the two-step atomic write (archive first, then
   design-state.md). On structural failure or write error, the orphan
   archive (if any) is harmless; the next turn re-triggers and produces
   a fresh archive.

4. On parse failure or write error, surface the error verbatim in chat
   with the prefix `compression skipped: ` and continue the loop. The
   next trigger fires from the unchanged design-state.md and is
   idempotent.

The canonical orchestrator-side state machine, including the
"defer dispatch when a prior compression is still running" rule, lives
in SKILL.md's "Compress entry point" section. The steps above are the
dispatch shape; SKILL.md is authoritative for the full async / retry
semantics.

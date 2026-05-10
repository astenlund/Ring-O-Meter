#!/usr/bin/env node
// parse-interpret-json.mjs
//
// Extract and validate the JSON block from an interpret subagent's
// response. The contract is documented in interpret-prompt.md's
// "Output format" section.
//
// Library use:  import { parseInterpretResponse } from './parse-interpret-json.mjs';
// CLI use:      cat response.txt | node parse-interpret-json.mjs
//                 prints validated JSON on stdout, errors on stderr,
//                 exits 0 on success and 1 on failure.

import { pathToFileURL } from 'node:url';

/**
 * Schema for the interpret subagent's response (single source of truth):
 *
 * Required:
 *   user_intent           string, non-empty.   1-3 sentence summary for next-render compose.
 *   design_state_delta    string, non-empty.   Markdown body to append under `## Iteration NN`.
 *   per_page_observations array of strings.    Per-annotated-page observations; empty array is valid.
 *
 * Reserved (deferred fields tracked in QUICK_WINS.md):
 *   slug_suggestion       turn-1-only kebab-case topic name; needs session-rename mechanism.
 *
 * When this schema changes, update interpret-prompt.md "Output format"
 * AND SKILL.md "Loop body" Step 4 in the same commit.
 */

const FENCE_PATTERN = /```json\s*\n([\s\S]*?)\n```/;

export function parseInterpretResponse(text) {
  const match = FENCE_PATTERN.exec(text);
  if (!match) {
    throw new Error(
      'no fenced ```json block found in subagent response',
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(match[1].replace(/\r/g, ''));
  } catch (err) {
    throw new Error(`malformed JSON in fenced block: ${err.message}`);
  }

  if (typeof parsed.user_intent !== 'string' || parsed.user_intent.length === 0) {
    throw new Error('missing or empty user_intent (must be non-empty string)');
  }
  if (typeof parsed.design_state_delta !== 'string' || parsed.design_state_delta.length === 0) {
    throw new Error('missing or empty design_state_delta (must be non-empty string)');
  }
  if (!Array.isArray(parsed.per_page_observations)) {
    throw new Error('per_page_observations must be an array');
  }
  for (const obs of parsed.per_page_observations) {
    if (typeof obs !== 'string') {
      throw new Error('per_page_observations entries must be strings');
    }
  }

  return parsed;
}

// CLI entry point: when invoked directly, read stdin, parse, print
// canonicalized JSON to stdout, exit 1 on any error.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks).toString('utf8');
  try {
    const result = parseInterpretResponse(input);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    process.stderr.write(`parse-interpret-json: ${err.message}\n`);
    process.exit(1);
  }
}

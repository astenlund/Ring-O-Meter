#!/usr/bin/env node
// parse-compress-response.mjs
//
// Extract and validate the JSON block from a compression subagent's
// response. The contract is documented in compress-prompt.md's
// "Response format" section.
//
// Library use:  import { parseCompressResponse } from './parse-compress-response.mjs';
// CLI use:      cat response.txt | node parse-compress-response.mjs
//                 prints validated JSON on stdout, errors on stderr,
//                 exits 0 on success and 1 on failure.

import { pathToFileURL } from 'node:url';

/**
 * Schema for the compression subagent's response (single source of truth):
 *
 * Required:
 *   archive_content            string, non-empty. Full text of the new
 *                              archive file, MUST start with a YAML
 *                              frontmatter block (`---\n...---\n`). The
 *                              subagent owns frontmatter authorship per
 *                              the "shell driver never parses YAML" rule.
 *   new_active_head_content    string, non-empty. Full replacement text
 *                              for design-state.md (frontmatter + kept
 *                              iter sections, verbatim). MUST start with
 *                              `---\n` (frontmatter must be preserved).
 *
 * Unknown extra fields are tolerated for forward compatibility.
 *
 * Structural invariants (archived turns absent / kept turns present in
 * new_active_head_content) are validated downstream in write_archive.py
 * where the turn-list inputs are available.
 *
 * When this schema changes, update compress-prompt.md "Response format"
 * AND SKILL.md "Compress entry point" in the same commit.
 */

const FENCE_PATTERN = /```json\s*\n([\s\S]*?)\n```/;

export function parseCompressResponse(text) {
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

  if (typeof parsed.archive_content !== 'string' || parsed.archive_content.length === 0) {
    throw new Error('missing or empty archive_content (must be non-empty string)');
  }
  if (typeof parsed.new_active_head_content !== 'string' || parsed.new_active_head_content.length === 0) {
    throw new Error('missing or empty new_active_head_content (must be non-empty string)');
  }
  if (!parsed.archive_content.startsWith('---\n')) {
    throw new Error('archive_content must start with YAML frontmatter (---\\n)');
  }
  if (!parsed.new_active_head_content.startsWith('---\n')) {
    throw new Error('new_active_head_content must start with YAML frontmatter (---\\n)');
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
    const result = parseCompressResponse(input);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    process.stderr.write(`parse-compress-response: ${err.message}\n`);
    process.exit(1);
  }
}

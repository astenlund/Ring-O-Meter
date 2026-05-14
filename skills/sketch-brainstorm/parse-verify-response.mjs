#!/usr/bin/env node
// parse-verify-response.mjs
//
// Extract and validate the JSON block from a verify subagent's
// response. The contract is documented in verify-prompt.md's
// "Response format" section.
//
// Library use:  import { parseVerifyResponse } from './parse-verify-response.mjs';
// CLI use:      cat response.txt | node parse-verify-response.mjs
//                 prints validated JSON on stdout, errors on stderr,
//                 exits 0 on success and 1 on failure.

import { pathToFileURL } from 'node:url';

/**
 * Schema for the verify subagent's response (single source of truth):
 *
 * Required:
 *   verdict  string, exactly "PASS" or "FAIL" (strict-cased).
 *   reason   string. On PASS must be "" (empty). On FAIL must be non-empty.
 *
 * The PASS-with-non-empty-reason rule is strict rejection, not silent
 * coercion. A subagent that returns {"verdict":"PASS","reason":"looks good"}
 * is hard-rejected so drift in subagent behavior surfaces as a visible
 * parse error rather than being coerced away.
 *
 * Unknown extra fields are tolerated for forward compatibility (e.g., a
 * future structured `concerns: [...]` field can ship without breaking
 * older parsers).
 *
 * When this schema changes, update verify-prompt.md "Response format"
 * AND SKILL.md "Verify entry point" in the same commit.
 */

const FENCE_PATTERN = /```json\s*\n([\s\S]*?)\n```/;

export function parseVerifyResponse(text) {
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

  if (parsed.verdict !== 'PASS' && parsed.verdict !== 'FAIL') {
    throw new Error(
      `verdict must be exactly "PASS" or "FAIL" (got ${JSON.stringify(parsed.verdict)})`,
    );
  }
  if (typeof parsed.reason !== 'string') {
    throw new Error('reason must be a string');
  }

  if (parsed.verdict === 'PASS' && parsed.reason !== '') {
    throw new Error(
      'reason must be empty string when verdict is PASS (asymmetric reason rule)',
    );
  }
  if (parsed.verdict === 'FAIL' && parsed.reason.length === 0) {
    throw new Error(
      'reason must be non-empty when verdict is FAIL (asymmetric reason rule)',
    );
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
    const result = parseVerifyResponse(input);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    process.stderr.write(`parse-verify-response: ${err.message}\n`);
    process.exit(1);
  }
}

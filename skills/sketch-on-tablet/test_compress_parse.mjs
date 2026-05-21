import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCompressResponse } from './parse-compress-response.mjs';

const VALID = `Some chatty preamble.

\`\`\`json
{
  "archive_content": "---\\nturn-range: 00-02\\ncreated: 2026-05-19T15:00:00Z\\n---\\n\\nSummary body\\n",
  "new_active_head_content": "---\\nslug: foo\\ntopic: bar\\ncurrent_mode: color\\n---\\n\\n## Iteration 03\\n\\nverbatim\\n\\n## Iteration 04\\n\\nverbatim\\n"
}
\`\`\`
`;

test('happy path returns both fields', () => {
  const r = parseCompressResponse(VALID);
  assert.equal(r.archive_content.startsWith('---\n'), true);
  assert.match(r.new_active_head_content, /## Iteration 03/);
});

test('CRLF line endings tolerated', () => {
  const r = parseCompressResponse(VALID.replace(/\n/g, '\r\n'));
  assert.equal(r.archive_content.startsWith('---\n'), true);
});

test('missing fenced block rejected', () => {
  assert.throws(() => parseCompressResponse('no fence at all'),
    /no fenced ```json block/);
});

test('malformed JSON rejected', () => {
  assert.throws(() => parseCompressResponse('```json\n{not json}\n```'),
    /malformed JSON/);
});

test('missing archive_content rejected', () => {
  const payload = '```json\n{"new_active_head_content":"x"}\n```';
  assert.throws(() => parseCompressResponse(payload),
    /missing or empty archive_content/);
});

test('empty archive_content rejected', () => {
  const payload = '```json\n{"archive_content":"","new_active_head_content":"x"}\n```';
  assert.throws(() => parseCompressResponse(payload),
    /missing or empty archive_content/);
});

test('missing new_active_head_content rejected', () => {
  const payload = '```json\n{"archive_content":"---\\nx\\n---\\n"}\n```';
  assert.throws(() => parseCompressResponse(payload),
    /missing or empty new_active_head_content/);
});

test('archive_content without frontmatter prefix rejected', () => {
  const payload = '```json\n{"archive_content":"no frontmatter here","new_active_head_content":"---\\nok\\n---\\n"}\n```';
  assert.throws(() => parseCompressResponse(payload),
    /archive_content must start with YAML frontmatter/);
});

test('new_active_head_content without frontmatter prefix rejected', () => {
  const payload = '```json\n{"archive_content":"---\\nok\\n---\\nbody","new_active_head_content":"## Iteration 05\\n\\nbody"}\n```';
  assert.throws(() => parseCompressResponse(payload),
    /new_active_head_content must start with YAML frontmatter/);
});

test('wrong-type fields rejected', () => {
  const payload = '```json\n{"archive_content":123,"new_active_head_content":"x"}\n```';
  assert.throws(() => parseCompressResponse(payload),
    /must be.*string/);
});

test('unknown extra fields tolerated', () => {
  const payload = `\`\`\`json
{
  "archive_content": "---\\nturn-range: 0-2\\n---\\nbody",
  "new_active_head_content": "---\\nslug: foo\\n---\\n\\n## Iteration 05\\n\\nbody",
  "future_field": {"nested": true}
}
\`\`\``;
  const r = parseCompressResponse(payload);
  assert.equal(typeof r.archive_content, 'string');
});

test('tight JSON block without trailing newline before closing fence is rejected', () => {
  // FENCE_PATTERN requires \n before ```. No trailing newline = no match.
  // Documents the constraint: subagent must emit a newline after the closing
  // brace and before the closing fence. Same constraint applies to
  // parse-interpret-json.mjs and parse-verify-response.mjs.
  const payload = '```json\n{"archive_content":"---\\nok\\n---\\nbody","new_active_head_content":"x"}```';
  assert.throws(() => parseCompressResponse(payload),
    /no fenced ```json block/);
});

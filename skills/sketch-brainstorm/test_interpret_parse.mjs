import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInterpretResponse } from './parse-interpret-json.mjs';

const HAPPY = `\`\`\`json
{
  "user_intent": "make the cancel button larger",
  "design_state_delta": "User accepted the slider position. Wants cancel button larger.",
  "per_page_observations": ["page 1: arrow at cancel button + plus sign"]
}
\`\`\``;

test('parses well-formed fenced JSON', () => {
  const result = parseInterpretResponse(HAPPY);
  assert.equal(result.user_intent, 'make the cancel button larger');
  assert.match(result.design_state_delta, /slider position/);
  assert.equal(result.per_page_observations.length, 1);
});

test('parses fenced JSON with CRLF line endings', () => {
  // Subagent responses transmitted across Windows-flavored channels can
  // arrive with CRLF inside the fenced block; bare \r is illegal in JSON
  // strings (RFC 8259 sec. 7) so the parser must strip them first.
  const crlf = HAPPY.replace(/\n/g, '\r\n');
  const result = parseInterpretResponse(crlf);
  assert.equal(result.user_intent, 'make the cancel button larger');
  assert.equal(result.per_page_observations.length, 1);
});

test('extracts JSON from chatty preamble', () => {
  const chatty = `Sure, here's the analysis:\n\n${HAPPY}`;
  const result = parseInterpretResponse(chatty);
  assert.equal(result.user_intent, 'make the cancel button larger');
});

test('throws on missing required field', () => {
  const missing = `\`\`\`json
{
  "user_intent": "x",
  "per_page_observations": []
}
\`\`\``;
  assert.throws(
    () => parseInterpretResponse(missing),
    /design_state_delta/,
  );
});

test('throws on wrong field type', () => {
  const wrongType = `\`\`\`json
{
  "user_intent": "x",
  "design_state_delta": "y",
  "per_page_observations": "not-an-array"
}
\`\`\``;
  assert.throws(
    () => parseInterpretResponse(wrongType),
    /per_page_observations.*array/,
  );
});

test('throws on non-string element inside per_page_observations', () => {
  // The Array.isArray check passes here; this exercises the per-element
  // branch that the wrong-type test does not reach.
  const wrongElement = `\`\`\`json
{
  "user_intent": "x",
  "design_state_delta": "y",
  "per_page_observations": [42]
}
\`\`\``;
  assert.throws(
    () => parseInterpretResponse(wrongElement),
    /per_page_observations.*string/,
  );
});

test('throws on no fenced JSON block', () => {
  const noFence = 'just some plain text, no json fence anywhere';
  assert.throws(
    () => parseInterpretResponse(noFence),
    /no.*fenced.*json/i,
  );
});

test('throws on malformed JSON inside fence', () => {
  const broken = `\`\`\`json
{ "user_intent": "x", malformed
\`\`\``;
  assert.throws(() => parseInterpretResponse(broken));
});

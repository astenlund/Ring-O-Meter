import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVerifyResponse } from './parse-verify-response.mjs';

const HAPPY_PASS = `\`\`\`json
{"verdict":"PASS","reason":""}
\`\`\``;

const HAPPY_FAIL = `\`\`\`json
{"verdict":"FAIL","reason":"text overflows mockup region"}
\`\`\``;

test('parses happy PASS', () => {
  const result = parseVerifyResponse(HAPPY_PASS);
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.reason, '');
});

test('parses happy FAIL', () => {
  const result = parseVerifyResponse(HAPPY_FAIL);
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.reason, 'text overflows mockup region');
});

test('parses fenced JSON with CRLF line endings', () => {
  // Subagent responses transmitted across Windows-flavored channels can
  // arrive with CRLF inside the fenced block; bare \r is illegal in JSON
  // strings (RFC 8259 sec. 7) so the parser must strip them first.
  const crlf = HAPPY_FAIL.replace(/\n/g, '\r\n');
  const result = parseVerifyResponse(crlf);
  assert.equal(result.verdict, 'FAIL');
  assert.equal(result.reason, 'text overflows mockup region');
});

test('throws on missing verdict field', () => {
  const missing = `\`\`\`json
{"reason":"something"}
\`\`\``;
  assert.throws(
    () => parseVerifyResponse(missing),
    /verdict/,
  );
});

test('throws on missing reason field', () => {
  const missing = `\`\`\`json
{"verdict":"PASS"}
\`\`\``;
  assert.throws(
    () => parseVerifyResponse(missing),
    /reason/,
  );
});

test('throws on wrong-cased verdict', () => {
  const lower = `\`\`\`json
{"verdict":"pass","reason":""}
\`\`\``;
  assert.throws(
    () => parseVerifyResponse(lower),
    /verdict.*PASS.*FAIL/,
  );

  const title = `\`\`\`json
{"verdict":"Pass","reason":""}
\`\`\``;
  assert.throws(
    () => parseVerifyResponse(title),
    /verdict.*PASS.*FAIL/,
  );
});

test('throws on PASS with non-empty reason (asymmetric rule)', () => {
  const bogus = `\`\`\`json
{"verdict":"PASS","reason":"looks good"}
\`\`\``;
  assert.throws(
    () => parseVerifyResponse(bogus),
    /reason.*empty.*PASS/,
  );
});

test('throws on FAIL with empty reason (asymmetric rule)', () => {
  const bogus = `\`\`\`json
{"verdict":"FAIL","reason":""}
\`\`\``;
  assert.throws(
    () => parseVerifyResponse(bogus),
    /reason.*non-empty.*FAIL/,
  );
});

test('throws on malformed JSON inside fence', () => {
  const broken = `\`\`\`json
{ "verdict": "PASS", malformed
\`\`\``;
  assert.throws(
    () => parseVerifyResponse(broken),
    /malformed JSON/,
  );
});

test('tolerates unknown extra fields (forward compat)', () => {
  const extra = `\`\`\`json
{"verdict":"PASS","reason":"","concerns":[]}
\`\`\``;
  const result = parseVerifyResponse(extra);
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.reason, '');
  assert.deepEqual(result.concerns, []);
});

test('extracts JSON from chatty preamble', () => {
  const chatty = `Sure, here is the verdict:\n\n${HAPPY_PASS}`;
  const result = parseVerifyResponse(chatty);
  assert.equal(result.verdict, 'PASS');
  assert.equal(result.reason, '');
});

test('throws on no fenced JSON block', () => {
  const noFence = 'just some plain text, no json fence anywhere';
  assert.throws(
    () => parseVerifyResponse(noFence),
    /no.*fenced.*json/i,
  );
});

// _parse_fence.mjs
//
// Shared fence-extraction + JSON-decode step for the parse-*-response.mjs
// family. Each parser receives a subagent's chatty response, finds the
// first ```json fenced block, strips CR for CRLF tolerance, and JSON-
// decodes the contents; only after that does it apply its own
// schema-specific validation.
//
// Keeping the fence regex and the decode wrapper in one place means a
// future change to the fence syntax (named fences, trailing-space
// tolerance, etc.) updates the contract for every parser at once.

const FENCE_PATTERN = /```json\s*\n([\s\S]*?)\n```/;

export function extractFencedJson(text) {
  const match = FENCE_PATTERN.exec(text);
  if (!match) {
    throw new Error('no fenced ```json block found in subagent response');
  }
  try {
    return JSON.parse(match[1].replace(/\r/g, ''));
  } catch (err) {
    throw new Error(`malformed JSON in fenced block: ${err.message}`);
  }
}

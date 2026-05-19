// node:test cases for the --project-mockup-css flag plumbing through
// render.mjs's CLI. We test the option-parsing surface and the resolved
// path, not the actual Chromium injection (which is covered by visual
// inspection during the smoke test).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const RENDER_MJS = join(SCRIPT_DIR, 'render.mjs');

test('render.mjs accepts --project-mockup-css flag', () => {
  // Invoke with only the new flag and no required flags. If the flag is
  // accepted, render.mjs proceeds past parseArgs and fails on the first
  // missing required flag (--topic). If the flag is unknown, parseArgs
  // rejects it before any required-flag check runs.
  const result = spawnSync(process.execPath, [
    RENDER_MJS,
    '--project-mockup-css', '/some/path.css',
  ], { encoding: 'utf8' });

  assert.notEqual(result.status, 0, 'render.mjs should exit non-zero when required flags are missing');

  const stderr = result.stderr.toLowerCase();
  assert.ok(
    !stderr.includes('unknown option'),
    `expected --project-mockup-css to be a known option; stderr: ${result.stderr}`,
  );
  // Check that the error is about a missing required flag, not about an
  // unknown option. The exact wording may change; check for 'topic' and
  // 'required' as independent substrings so a cosmetic rewording doesn't
  // silently invert the assertion.
  assert.ok(
    stderr.includes('topic') && stderr.includes('required'),
    `expected failure on missing --topic (which only fires after parseArgs succeeds); stderr: ${result.stderr}`,
  );
});

// _parse_cli_runner.mjs
//
// Shared CLI driver for the parse-*-response.mjs family. Each parser
// module is library-first (exports a parseFoo(text) function) and gets
// a thin CLI bottom that:
//   - reads stdin to completion
//   - calls the parser
//   - writes canonicalized JSON to stdout on success
//   - writes "<script-basename>: <error>" to stderr and exits 1 on failure
//
// The script-basename for the stderr prefix is derived from
// process.argv[1] (guaranteed to be the calling script because each
// caller's CLI guard is `import.meta.url === pathToFileURL(process.argv[1]).href`),
// so a parser rename doesn't require a paired string-literal update at
// the call site. Assumes callers use the `.mjs` extension; a `.js`
// sibling would surface as a prefix with the extension still attached,
// which is visible at first invocation rather than silent.

import { basename } from 'node:path';

export async function runParseCli(parseFn) {
  const scriptName = basename(process.argv[1], '.mjs');
  const chunks = [];
  for await (const chunk of process.stdin) {
    chunks.push(chunk);
  }
  const input = Buffer.concat(chunks).toString('utf8');
  try {
    const result = parseFn(input);
    process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  } catch (err) {
    process.stderr.write(`${scriptName}: ${err.message}\n`);
    process.exit(1);
  }
}

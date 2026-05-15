// render.mjs
//
// Substitutes tokens in page-template.html, launches Chromium via
// Playwright, and writes a PDF at the reMarkable
// Paper Pro viewport (1620x2160 px).
//
// Bare-specifier ESM resolution does NOT walk cwd's node_modules tree;
// it walks the importing file's tree. SKETCH_BRAINSTORM_NODE_HOST (set
// by render-html-to-pdf.sh) points at a directory that contains
// node_modules/playwright: either the skill's own node_modules (when
// `npm install` has been run in the skill folder) or the host repo's
// web/ folder as a fallback for in-repo incubation. The env-var
// contract is unchanged; only the source directory varies.

import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';

const VIEWPORT_WIDTH = 1620;
const VIEWPORT_HEIGHT = 2160;

// LOCKSTEP with `_chrome_boxes.VALID_MODES` (Python). Same canonical
// tuple, duplicated only because JS cannot import from Python.
const VALID_MODES = ['color', 'bw', 'wireframe'];
const DEFAULT_MODE = 'color';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const TEMPLATE_PATH = join(SCRIPT_DIR, 'page-template.html');
const TEMP_HTML_PATH = '.tmp/sketch-brainstorm/test/render-input.html';

export function formatIterationLabel(iteration, subtopic) {
  // LOCKSTEP with ITER_NN_RE in render/_chrome_boxes.py. Two-digit
  // minimum (rejects single-digit input that the section regex
  // cannot match) but no upper bound (sessions can exceed 99 iters).
  if (!/^\d{2,}$/.test(iteration)) {
    throw new Error(
      `--iteration must be at least two decimal digits (e.g. 00, 100); got: ${iteration}`,
    );
  }
  const subtopicSegment = subtopic ? `: ${subtopic} ` : '';

  return `${subtopicSegment}#${iteration}`;
}

function fail(message) {
  console.error(`render.mjs: ${message}`);
  process.exit(1);
}

function loadPlaywright() {
  const host = process.env.SKETCH_BRAINSTORM_NODE_HOST;
  if (!host) {
    fail(
      'SKETCH_BRAINSTORM_NODE_HOST is not set. The bash wrapper '
      + 'render-html-to-pdf.sh sets this to whichever directory contains '
      + 'node_modules/playwright (skills/sketch-brainstorm or the host '
      + 'repo\'s web/ folder, depending on which install you have). Either '
      + 'run via the wrapper or export the env var manually to a directory '
      + 'containing package.json with playwright as a dep.'
    );
  }
  const anchor = pathToFileURL(join(host, 'package.json')).href;
  const require = createRequire(anchor);
  try {
    return require('playwright');
  } catch (err) {
    fail(
      `Could not resolve playwright from ${host}. Ensure node_modules/playwright is installed in ${host}. Original error: ${err.message}`
    );
  }
}

async function readMockupHtml(mockupPath) {
  if (!mockupPath) {
    return '';
  }
  try {
    return await readFile(mockupPath, 'utf8');
  } catch (err) {
    fail(`Could not read mockup HTML at ${mockupPath}: ${err.message}`);
  }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function substituteTokens(template, tokens) {
  return template
    .replaceAll('{{topic}}', escapeHtml(tokens.topic))
    .replaceAll('{{iteration_label}}', escapeHtml(tokens.iteration_label))
    .replaceAll('{{current_mode}}', escapeHtml(tokens.current_mode))
    .replaceAll('{{mockup_html}}', tokens.mockup_html); // intentionally raw HTML
}

async function ensureDir(filePath) {
  await mkdir(dirname(filePath), { recursive: true });
}

function resolveOutPath(rawOut) {
  return isAbsolute(rawOut) ? rawOut : resolve(process.cwd(), rawOut);
}

function resolveTempHtmlPath() {
  // Anchor on the repo root rather than process.cwd() so the temp HTML
  // always lands at <repo-root>/.tmp/sketch-brainstorm/test/
  // regardless of which directory the wrapper was invoked from. The
  // bash wrapper sets SKETCH_BRAINSTORM_REPO_ROOT after walking up to
  // find Ring-O-Meter.slnx; falls back to cwd if missing.
  const repoRoot = process.env.SKETCH_BRAINSTORM_REPO_ROOT || process.cwd();

  return resolve(repoRoot, TEMP_HTML_PATH);
}

async function main() {
  const { values } = parseArgs({
    options: {
      topic: { type: 'string' },
      iteration: { type: 'string' },
      subtopic: { type: 'string' },
      out: { type: 'string' },
      'mockup-html': { type: 'string' },
      'current-mode': { type: 'string' },
    },
    strict: true,
  });

  if (!values.topic) {
    fail('--topic is required');
  }
  if (!values.iteration) {
    fail('--iteration is required (two-digit zero-padded number, e.g. 00, 01, 05)');
  }
  if (!values.out) {
    fail('--out is required');
  }

  const currentMode = values['current-mode'] ?? DEFAULT_MODE;
  if (!VALID_MODES.includes(currentMode)) {
    fail(
      `--current-mode must be one of ${VALID_MODES.join(', ')}; got: ${currentMode}`,
    );
  }

  const playwright = loadPlaywright();
  const template = await readFile(TEMPLATE_PATH, 'utf8');
  const mockupHtml = await readMockupHtml(values['mockup-html']);

  const headerIteration = formatIterationLabel(values.iteration, values.subtopic);

  const rendered = substituteTokens(template, {
    topic: values.topic,
    iteration_label: headerIteration,
    current_mode: currentMode,
    mockup_html: mockupHtml,
  });

  const tempHtmlPath = resolveTempHtmlPath();
  const outPath = resolveOutPath(values.out);

  await ensureDir(tempHtmlPath);
  await ensureDir(outPath);

  // Replace the template's relative href="page-chrome.css" with an absolute
  // file:// URL so Chromium resolves it regardless of where the temp HTML
  // lands, eliminating the copy-to-temp-dir step entirely.
  const cssFileUrl = pathToFileURL(join(SCRIPT_DIR, 'page-chrome.css')).href;
  const renderedWithAbsoluteCss = rendered.replace(
    'href="page-chrome.css"',
    `href="${cssFileUrl}"`,
  );
  if (renderedWithAbsoluteCss === rendered) {
    fail('page-template.html does not contain href="page-chrome.css" — CSS will not load');
  }

  await writeFile(tempHtmlPath, renderedWithAbsoluteCss, 'utf8');

  const browser = await playwright.chromium.launch({ channel: 'chrome' });
  try {
    // Pass viewport at context creation so initial layout, web font loading,
    // and the networkidle wait all happen against the target dimensions.
    // Setting viewport after navigate would lay out at the default
    // 1280x720 first, fire networkidle against that, then re-layout on
    // resize without re-triggering font load.
    // javaScriptEnabled: false is a defensive default: the template does
    // not use JS, and the --mockup-html file is LLM-generated content that
    // should not execute arbitrary scripts inside a file:// Chromium context
    // (which has unrestricted local filesystem read access).
    const context = await browser.newContext({
      javaScriptEnabled: false,
      viewport: { width: VIEWPORT_WIDTH, height: VIEWPORT_HEIGHT },
    });
    const page = await context.newPage();
    // page.pdf() defaults to print media, which silently drops @media
    // screen rules and applies UA print-stylesheet defaults. Force
    // screen media before navigate so any media-conditional CSS is
    // evaluated against the correct media during initial load; the
    // polling slice's hardcoded checkbox crop coords depend on this.
    await page.emulateMedia({ media: 'screen' });
    const fileUrl = pathToFileURL(tempHtmlPath).href;
    // waitUntil: 'networkidle' so web fonts and any remote resources are
    // settled before page.pdf() snapshots. Default 'load' fires too early
    // and the PDF can capture fallback fonts.
    await page.goto(fileUrl, { waitUntil: 'networkidle' });
    // Mode stylesheets are injected via addStyleTag's `path` option, which
    // reads from the absolute SCRIPT_DIR location directly. page-chrome.css
    // is referenced by an absolute file:// URL in the rendered HTML so
    // Chromium resolves it without a copy step; addStyleTag works the same
    // way for mode sheets.
    if (currentMode === 'bw') {
      // Style injection is synchronous; no fonts in this sheet, so no
      // networkidle wait needed before page.pdf().
      await page.addStyleTag({ path: join(SCRIPT_DIR, 'page-chrome-bw.css') });
    }
    if (currentMode === 'wireframe') {
      await page.addStyleTag({ path: join(SCRIPT_DIR, 'page-chrome-wireframe.css') });
    }
    // printBackground: true so CSS backgrounds (header strip fill, legend
    // panel fill, checkbox border) actually render. Without it the
    // chrome region prints white.
    await page.pdf({
      path: outPath,
      width: `${VIEWPORT_WIDTH}px`,
      height: `${VIEWPORT_HEIGHT}px`,
      printBackground: true,
    });
  } finally {
    await browser.close();
  }

  console.error(`render.mjs: wrote ${outPath}`);
}

// Run main() only when invoked directly, not when imported as a module.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}

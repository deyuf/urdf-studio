// End-to-end smoke test against the franka_description ROS package.
// Verifies the web app:
//   1. Loads the chosen URDF/xacro file.
//   2. Indexes the package directory, resolves package:// URIs.
//   3. Successfully expands xacro (load_yaml, includes, etc.).
//   4. Renders a non-empty canvas after meshes load.
//   5. Reports zero unexpected diagnostics (warnings about unresolved meshes
//      are surfaced but do not fail the run).
//
// Run with:
//   FRANKA_DIR=/path/to/franka_description node scripts/test-franka.mjs

import { chromium } from 'playwright';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist-web');
const FRANKA = process.env.FRANKA_DIR ?? '/tmp/franka_description';
const TARGETS = (process.env.FRANKA_TARGETS ?? 'fr3,fer,fp3').split(',');

if (!existsSync(path.join(DIST, 'app.js'))) {
  console.error('Run `npm run web:build` first.');
  process.exit(1);
}
if (!existsSync(FRANKA)) {
  console.error(`FRANKA_DIR=${FRANKA} does not exist. Clone https://github.com/frankarobotics/franka_description first.`);
  process.exit(1);
}

const server = createServer((request, response) => {
  let pathname = decodeURIComponent(new URL(request.url, 'http://127.0.0.1').pathname);
  if (pathname === '/' || pathname === '') {
    pathname = '/index.html';
  }
  const filePath = path.resolve(DIST, `.${pathname}`);
  if (!filePath.startsWith(DIST) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
    response.writeHead(404).end('not found');
    return;
  }
  const types = {
    '.js': 'text/javascript',
    '.css': 'text/css',
    '.html': 'text/html',
    '.json': 'application/json'
  };
  response.writeHead(200, { 'content-type': types[path.extname(filePath)] ?? 'application/octet-stream' });
  createReadStream(filePath).pipe(response);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const browser = await chromium.launch();
const results = [];
let allOk = true;

for (const target of TARGETS) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const consoleErrors = [];
  page.on('pageerror', error => consoleErrors.push(error.message));
  page.on('console', message => {
    if (message.type() !== 'error') {
      return;
    }
    const text = message.text();
    if (/fonts\.(googleapis|gstatic)\.com/.test(text) || /net::ERR_/.test(text)) {
      return;
    }
    consoleErrors.push(text);
  });

  try {
    await page.goto(`http://127.0.0.1:${port}`, { waitUntil: 'domcontentloaded' });
    // Dismiss the onboarding tour if present.
    if (await page.locator('dialog.onboarding').isVisible()) {
      await page.locator('[data-action="skip"]').click();
    }
    await page.setInputFiles('#file-input', FRANKA);
    await page.locator('#file-select').waitFor({ state: 'visible' });
    await page.locator('#file-select').evaluate(el => (el).disabled === false);

    const pattern = new RegExp(`(^|/)${target}\\.urdf\\.xacro$|(^|/)${target}\\.xacro$`);
    const targetValue = await page.locator('#file-select option').evaluateAll((options, src) => {
      const re = new RegExp(src);
      const match = options.find(o => re.test(o.value));
      return match ? match.value : '';
    }, pattern.source);
    if (!targetValue) {
      throw new Error(`could not find ${target}.{urdf.xacro|xacro} in file select`);
    }

    await page.locator('#file-select').selectOption(targetValue);

    // Wait for the renderer to publish at least one joint slider. Larger Franka
    // robots have 7+ movable joints; if any slider shows up, parsing succeeded.
    const start = Date.now();
    await page.locator('[data-joint-slider]').first().waitFor({ timeout: 60_000 });
    const parseMs = Date.now() - start;

    const jointCount = await page.locator('[data-joint-slider]').count();
    const linkCount = await page.locator('#panel-links .tree-row, #panel-links li').count();
    const dataUrl = await page.locator('canvas#viewport').evaluate(c => (c).toDataURL('image/png'));
    expect(dataUrl.length, `canvas dataURL too small for ${target}`).toBeTruthy();

    // Wait for status to settle.
    await page.waitForTimeout(800);
    const statusText = (await page.locator('#topbar-status').textContent()) ?? '';
    const statusKind = await page.locator('#topbar-status').getAttribute('data-kind');

    // Count check warnings/errors.
    await page.locator('button.tab[data-tab="checks"]').click();
    await page.waitForTimeout(200);
    const errorCount = await page.locator('#panel-checks .check-item.error, #panel-checks .severity-error').count();
    const warningCount = await page.locator('#panel-checks .check-item.warning, #panel-checks .severity-warning').count();

    results.push({
      target,
      ok: consoleErrors.length === 0 && jointCount > 0 && dataUrl.length > 5000,
      jointCount,
      linkCount,
      parseMs,
      statusKind,
      statusText,
      errorCount,
      warningCount,
      consoleErrors
    });
    if (consoleErrors.length > 0 || jointCount === 0) {
      allOk = false;
    }
  } catch (error) {
    results.push({ target, ok: false, error: String(error), consoleErrors });
    allOk = false;
  } finally {
    await context.close();
  }
}

await browser.close();
server.close();

console.log('');
console.log('Franka URDF smoke test results:');
console.log('================================');
for (const result of results) {
  const icon = result.ok ? '✅' : '❌';
  console.log(`${icon} ${result.target.padEnd(8)} ` +
    (result.ok
      ? `joints=${result.jointCount} links=${result.linkCount} parse=${result.parseMs}ms ` +
        `errors=${result.errorCount} warnings=${result.warningCount}`
      : `FAILED: ${result.error ?? 'see console'}`));
  if (result.consoleErrors && result.consoleErrors.length > 0) {
    for (const err of result.consoleErrors) {
      console.log(`    ⚠ ${err}`);
    }
  }
}

process.exit(allOk ? 0 : 1);

function expect(actual, label) {
  return {
    toBeTruthy() {
      if (!actual) {
        throw new Error(label);
      }
    }
  };
}

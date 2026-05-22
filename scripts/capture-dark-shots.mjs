// Re-capture every "web" screenshot referenced by the project in dark mode
// and overwrite the existing file in media/screenshots-web/.
//
// Run from repo root:
//   npm run web:build
//   git clone https://github.com/frankarobotics/franka_description /tmp/franka_description  (one time)
//   node scripts/capture-dark-shots.mjs

import { chromium } from 'playwright';
import { createReadStream, existsSync, statSync, mkdirSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist-web');
const FRANKA = process.env.FRANKA_DIR ?? '/tmp/franka_description';
const OUT_DIR = path.join(REPO, 'media', 'screenshots-web');
mkdirSync(OUT_DIR, { recursive: true });

if (!existsSync(path.join(DIST, 'app.js'))) {
  console.error('Run `npm run web:build` first.');
  process.exit(1);
}
if (!existsSync(FRANKA)) {
  console.error(`FRANKA_DIR=${FRANKA} does not exist.`);
  process.exit(1);
}

const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/' || p === '') p = '/index.html';
  if (p.endsWith('/')) p += 'index.html';
  const fp = path.resolve(DIST, `.${p}`);
  if (!fp.startsWith(DIST) || !existsSync(fp) || statSync(fp).isDirectory()) {
    return res.writeHead(404).end();
  }
  const types = {
    '.js': 'text/javascript', '.css': 'text/css',
    '.html': 'text/html', '.png': 'image/png',
    '.json': 'application/json'
  };
  res.writeHead(200, { 'content-type': types[path.extname(fp)] ?? 'application/octet-stream' });
  createReadStream(fp).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const URL_ROOT = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({ args: ['--force-color-profile=srgb'] });

async function setJoint(page, index, value) {
  await page.locator('[data-joint-slider]').nth(index).evaluate((el, v) => {
    const input = el;
    input.value = String(v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

async function newDarkPage(width = 1440, height = 900) {
  const ctx = await browser.newContext({
    viewport: { width, height },
    colorScheme: 'dark'
  });
  const page = await ctx.newPage();
  return { ctx, page };
}

async function dismissOnboarding(page) {
  if (await page.locator('dialog.onboarding').isVisible()) {
    await page.locator('[data-action="skip"]').click();
  }
}

async function openFranka(page, robot = 'fr3') {
  await page.setInputFiles('#file-input', FRANKA);
  await page.locator('#file-select').waitFor();
  const target = await page.locator('#file-select option').evaluateAll((opts, name) => {
    const re = new RegExp(`(^|/)${name}\\.urdf\\.xacro$`);
    const m = opts.find(o => re.test(o.value));
    return m ? m.value : '';
  }, robot);
  await page.locator('#file-select').selectOption(target);
  await page.locator('[data-joint-slider]').first().waitFor({ timeout: 60_000 });
}

// 01 — Welcome onboarding dialog.
{
  const { ctx, page } = await newDarkPage();
  await page.goto(URL_ROOT);
  await page.waitForSelector('dialog.onboarding');
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT_DIR, '01-welcome.png') });
  await ctx.close();
  console.log('01-welcome.png — dark');
}

// 02 — FR3 default pose (used in some past versions of README).
{
  const { ctx, page } = await newDarkPage();
  await page.goto(URL_ROOT);
  await dismissOnboarding(page);
  await openFranka(page);
  await page.waitForTimeout(1800);
  await page.screenshot({ path: path.join(OUT_DIR, '02-fr3-light.png') });
  await ctx.close();
  console.log('02-fr3-light.png — dark (filename kept for compatibility)');
}

// 03 — FR3 with a posed configuration (the README hero shot).
{
  const { ctx, page } = await newDarkPage();
  await page.goto(URL_ROOT);
  await dismissOnboarding(page);
  await openFranka(page);
  await setJoint(page, 1, 0.8);
  await setJoint(page, 3, -1.2);
  await setJoint(page, 5, 1.6);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT_DIR, '03-fr3-posed.png') });
  await ctx.close();
  console.log('03-fr3-posed.png — dark');
}

// 04 — Checks panel.
{
  const { ctx, page } = await newDarkPage();
  await page.goto(URL_ROOT);
  await dismissOnboarding(page);
  await openFranka(page);
  await page.locator('.tab[data-tab="checks"]').click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT_DIR, '04-checks.png') });
  await ctx.close();
  console.log('04-checks.png — dark');
}

// 05 — Inspector tab.
{
  const { ctx, page } = await newDarkPage();
  await page.goto(URL_ROOT);
  await dismissOnboarding(page);
  await openFranka(page);
  await page.locator('.tab[data-tab="inspector"]').click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT_DIR, '05-inspector.png') });
  await ctx.close();
  console.log('05-inspector.png — dark');
}

// 06 — FR3 dark posed (this was already dark but resnap with new layout).
{
  const { ctx, page } = await newDarkPage();
  await page.goto(URL_ROOT);
  await dismissOnboarding(page);
  await openFranka(page);
  await setJoint(page, 1, 0.6);
  await setJoint(page, 3, -0.9);
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT_DIR, '06-fr3-dark.png') });
  await ctx.close();
  console.log('06-fr3-dark.png — dark');
}

// 07 — small placeholder. Delete; never used and the bytes are tiny.
{
  const stale = path.join(OUT_DIR, '07-docs.png');
  if (existsSync(stale)) {
    unlinkSync(stale);
    console.log('07-docs.png — removed (unused)');
  }
}

// 08 — Docs landing page.
{
  const { ctx, page } = await newDarkPage(1280, 800);
  await page.goto(`${URL_ROOT}/docs/`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT_DIR, '08-docs-overview.png') });
  await ctx.close();
  console.log('08-docs-overview.png — dark');
}

// 09 — Architecture browser-host page (deeper docs URL).
{
  const { ctx, page } = await newDarkPage(1280, 800);
  await page.goto(`${URL_ROOT}/docs/architecture/browser.html`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT_DIR, '09-docs-browser.png') });
  await ctx.close();
  console.log('09-docs-browser.png — dark');
}

// 10 — Diagnostics catalog page (table-heavy).
{
  const { ctx, page } = await newDarkPage(1280, 800);
  await page.goto(`${URL_ROOT}/docs/features/diagnostics.html`);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT_DIR, '10-docs-diagnostics.png') });
  await ctx.close();
  console.log('10-docs-diagnostics.png — dark');
}

// 11 — Error toast.
{
  const { ctx, page } = await newDarkPage();
  await page.goto(URL_ROOT);
  await dismissOnboarding(page);
  await page.setInputFiles('#file-input', path.join(REPO, 'test', 'fixtures', 'bad_urdf'));
  await page.locator('#file-select').waitFor();
  const target = await page.locator('#file-select option').evaluateAll(opts => {
    const m = opts.find(o => /missing_mesh\.urdf$/.test(o.value));
    return m ? m.value : '';
  });
  await page.locator('#file-select').selectOption(target);
  await page.locator('#toast-container .toast-error').waitFor();
  await page.waitForTimeout(800);
  await page.screenshot({ path: path.join(OUT_DIR, '11-toast-error.png') });
  await ctx.close();
  console.log('11-toast-error.png — dark');
}

await browser.close();
server.close();
console.log(`\nAll screenshots refreshed in dark mode at ${path.relative(REPO, OUT_DIR)}/`);

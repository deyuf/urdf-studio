// Capture polished screenshots for the README.
import { chromium } from 'playwright';
import { createReadStream, existsSync, mkdirSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist-web');
const FRANKA = process.env.FRANKA_DIR ?? '/tmp/franka_description';
const OUT_DIR = path.join(REPO, 'media', 'screenshots-web');
mkdirSync(OUT_DIR, { recursive: true });

const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/' || p === '') p = '/index.html';
  const fp = path.resolve(DIST, `.${p}`);
  if (!fp.startsWith(DIST) || !existsSync(fp) || statSync(fp).isDirectory()) {
    return res.writeHead(404).end();
  }
  const t = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[path.extname(fp)] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': t });
  createReadStream(fp).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const port = server.address().port;
const URL_ROOT = `http://127.0.0.1:${port}`;

const browser = await chromium.launch({ args: ['--force-color-profile=srgb'] });

// 1. Welcome dialog.
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await ctx.newPage();
  await page.goto(URL_ROOT);
  await page.waitForSelector('dialog.onboarding');
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT_DIR, '01-welcome.png') });
  await ctx.close();
}

// 2. FR3 loaded — light theme.
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'light' });
  const page = await ctx.newPage();
  await page.goto(URL_ROOT);
  await page.locator('[data-action="skip"]').click();
  await page.setInputFiles('#file-input', FRANKA);
  await page.locator('#file-select').waitFor();
  const target = await page.locator('#file-select option').evaluateAll(opts => {
    const m = opts.find(o => /(^|\/)fr3\.urdf\.xacro$/.test(o.value));
    return m ? m.value : '';
  });
  await page.locator('#file-select').selectOption(target);
  await page.locator('[data-joint-slider]').first().waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT_DIR, '02-fr3-light.png') });

  // Move a few joints via the numeric input (range fill is finicky).
  await setJoint(page, 1, 0.8);
  await setJoint(page, 3, -1.2);
  await setJoint(page, 5, 1.6);
  await page.waitForTimeout(500);
  await page.screenshot({ path: path.join(OUT_DIR, '03-fr3-posed.png') });

  // Switch to Checks panel.
  await page.locator('.tab[data-tab="checks"]').click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT_DIR, '04-checks.png') });

  // Switch to Inspector.
  await page.locator('.tab[data-tab="inspector"]').click();
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT_DIR, '05-inspector.png') });

  await ctx.close();
}

// 3. FR3 loaded — dark theme.
{
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
  const page = await ctx.newPage();
  await page.goto(URL_ROOT);
  await page.locator('[data-action="skip"]').click();
  await page.setInputFiles('#file-input', FRANKA);
  await page.locator('#file-select').waitFor();
  const target = await page.locator('#file-select option').evaluateAll(opts => {
    const m = opts.find(o => /(^|\/)fr3\.urdf\.xacro$/.test(o.value));
    return m ? m.value : '';
  });
  await page.locator('#file-select').selectOption(target);
  await page.locator('[data-joint-slider]').first().waitFor({ timeout: 60_000 });
  await setJoint(page, 1, 0.6);
  await setJoint(page, 3, -0.9);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: path.join(OUT_DIR, '06-fr3-dark.png') });
  await ctx.close();
}

// 4. Docs page.
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'light' });
  const page = await ctx.newPage();
  await page.goto(`${URL_ROOT}/docs/`);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT_DIR, '07-docs.png') });
  await ctx.close();
}

await browser.close();
server.close();
console.log(`Saved screenshots to ${path.relative(REPO, OUT_DIR)}/`);

async function setJoint(page, index, value) {
  await page.locator('[data-joint-slider]').nth(index).evaluate((el, v) => {
    const input = el;
    input.value = String(v);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
}

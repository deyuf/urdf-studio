import { chromium } from 'playwright';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');
const DIST = path.join(REPO_ROOT, 'dist-web');
const FIXTURE = path.join(REPO_ROOT, 'test', 'fixtures');

if (!existsSync(path.join(DIST, 'app.js'))) {
  console.error('Run `npm run web:build` first.');
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
  const types = { '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
  const ext = path.extname(filePath);
  response.writeHead(200, { 'content-type': types[ext] ?? 'text/html' });
  createReadStream(filePath).pipe(response);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
await page.goto(`http://127.0.0.1:${port}`);
await page.locator('#topbar').waitFor();
await page.setInputFiles('#file-input', FIXTURE);
await page.locator('#file-select').waitFor({ state: 'visible' });
const target = await page.locator('#file-select option').evaluateAll(opts => {
  const found = opts.find(o => /(^|\/)model\.xacro$/.test(o.value));
  return found ? found.value : '';
});
if (target) {
  await page.locator('#file-select').selectOption(target);
}
await page.locator('[data-joint-slider="fixture_joint"]').waitFor({ timeout: 15_000 });
await page.locator('[data-joint-slider="fixture_joint"]').fill('0.6');
await page.waitForTimeout(400);
const outPath = path.join(REPO_ROOT, 'screenshot-web.png');
await page.screenshot({ path: outPath, fullPage: false });
console.log(`Saved ${outPath}`);
await browser.close();
server.close();

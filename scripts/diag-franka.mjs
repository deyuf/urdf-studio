// Diagnostic: print what loadRobot actually contains for a Franka URDF.
import { chromium } from 'playwright';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const DIST = path.join(REPO, 'dist-web');
const FRANKA = process.env.FRANKA_DIR ?? '/tmp/franka_description';
const TARGET = process.env.FRANKA_TARGET ?? 'fr3';

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

const browser = await chromium.launch();
const page = await browser.newPage();

await page.addInitScript(() => {
  const w = window;
  w.__loadRobotMsg = null;
  w.__urlModifierHits = [];
  w.__failedFetches = [];
  const origPost = window.postMessage.bind(window);
  window.postMessage = (msg, ...rest) => {
    if (msg?.type === 'loadRobot') {
      w.__loadRobotMsg = {
        format: msg.format,
        urdfLength: msg.urdf?.length,
        meshCount: msg.metadata?.meshes?.length,
        meshesExisting: msg.metadata?.meshes?.filter(m => m.exists).length,
        firstFewMeshes: msg.metadata?.meshes?.slice(0, 5),
        packageMap: msg.packageMap,
        sourceBaseUri: msg.sourceBaseUri,
        vfsUrlMapSize: Object.keys(msg.vfsUrlMap || {}).length,
        firstFewVfsKeys: Object.keys(msg.vfsUrlMap || {}).slice(0, 5),
        diagnostics: msg.diagnostics?.slice(0, 10)
      };
    }
    return origPost(msg, ...rest);
  };
});

page.on('console', msg => {
  if (msg.type() === 'error' && !msg.text().includes('fonts.')) {
    console.log('[browser err]', msg.text().substring(0, 200));
  }
});
page.on('requestfailed', req => {
  if (req.url().includes('blob:') || req.url().includes('urdf-studio')) {
    console.log('[req failed]', req.url(), '-', req.failure()?.errorText);
  }
});

await page.goto(`http://127.0.0.1:${port}`);
if (await page.locator('dialog.onboarding').isVisible()) {
  await page.locator('[data-action="skip"]').click();
}
await page.setInputFiles('#file-input', FRANKA);
await page.locator('#file-select').waitFor({ state: 'visible' });
await page.waitForFunction(el => !el.disabled, await page.locator('#file-select').elementHandle());

const targetValue = await page.locator('#file-select option').evaluateAll((opts, target) => {
  const re = new RegExp(`(^|/)${target}\\.urdf\\.xacro$`);
  const match = opts.find(o => re.test(o.value));
  return match ? match.value : '';
}, TARGET);

if (!targetValue) {
  console.error('Could not find target:', TARGET);
  process.exit(1);
}

console.log('Loading', targetValue);
await page.locator('#file-select').selectOption(targetValue);
await page.waitForFunction(() => window.__loadRobotMsg !== null, null, { timeout: 30_000 });

const info = await page.evaluate(() => window.__loadRobotMsg);
console.log(JSON.stringify(info, null, 2));

await page.waitForTimeout(3000);
const failedFetches = await page.evaluate(() => window.__failedFetches);
console.log('Failed fetches recorded by page:', failedFetches?.length || 0);

await browser.close();
server.close();

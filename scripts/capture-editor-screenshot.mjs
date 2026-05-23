// Captures a screenshot of the new editor showing the Franka FR3 URDF.
//
// Usage:
//   node scripts/capture-editor-screenshot.mjs
//
// Output: media/screenshots-web/12-editor-franka.png

import { chromium } from 'playwright';
import { createReadStream, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'media', 'screenshots-web');
mkdirSync(OUT_DIR, { recursive: true });

async function startStaticServer(root) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const filePath = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!filePath.startsWith(root) || !existsSync(filePath)) {
      res.writeHead(404); res.end('not found'); return;
    }
    const ct = filePath.endsWith('.js') ? 'text/javascript'
      : filePath.endsWith('.css') ? 'text/css'
      : filePath.endsWith('.png') ? 'image/png'
      : 'text/html';
    res.writeHead(200, { 'content-type': ct });
    createReadStream(filePath).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  return { url: `http://127.0.0.1:${addr.port}`, close: () => new Promise(r => server.close(r)) };
}

const FRANKA = path.join(ROOT, 'test', 'fixtures', 'franka_primitives.urdf');
const urdf = readFileSync(FRANKA, 'utf-8');

function buildLoadRobotMessage() {
  const links = {};
  for (const m of urdf.matchAll(/<link\s+name="([^"]+)"/g)) {
    links[m[1]] = { name: m[1], childJoints: [], line: 0 };
  }
  const joints = {};
  for (const m of urdf.matchAll(/<joint\s+name="([^"]+)"\s+type="([^"]+)"/g)) {
    joints[m[1]] = { name: m[1], type: m[2], axis: [0, 0, 1], limit: {}, line: 0 };
  }
  return {
    type: 'loadRobot',
    fileName: 'fr3_primitives.urdf',
    sourcePath: 'fr3_primitives.urdf',
    sourceBaseUri: '',
    format: 'urdf',
    urdf,
    packageMap: {},
    metadata: {
      robotName: 'fr3_primitives',
      counts: { links: Object.keys(links).length, joints: Object.keys(joints).length, movableJoints: 8, visualMeshes: 0, collisionMeshes: 0 },
      links,
      joints,
      meshes: [],
      rootLinks: ['fr3_link0'],
      movableJointNames: Object.keys(joints).filter(n => joints[n].type !== 'fixed'),
      tree: [{ link: 'fr3_link0', children: [] }],
      diagnostics: []
    },
    semantic: { groups: [], states: [], disableCollisions: [], diagnostics: [] },
    diagnostics: [],
    xacroArgs: [],
    xacroArgValues: {},
    renderSettings: { renderMode: 'visual', upAxis: '+Z' }
  };
}

const server = await startStaticServer(ROOT);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: 'dark' });
const page = await ctx.newPage();
try {
  await page.goto(`${server.url}/test/renderer/harness.html`);
  await page.waitForFunction(() => Array.isArray(window.__messages) && window.__messages.some(m => m?.type === 'ready'), { timeout: 30_000 });
  await page.evaluate(payload => {
    window.dispatchEvent(new MessageEvent('message', { data: payload }));
  }, buildLoadRobotMessage());
  // Wait for joints panel to populate (signals load complete).
  await page.waitForSelector('[data-joint-slider]');
  // Switch to source tab so the editor is visible in screenshot.
  await page.locator('[data-tab="source"]').click();
  await page.waitForSelector('#panel-source .cm-editor');
  await page.waitForTimeout(800);

  const out = path.join(OUT_DIR, '12-editor-franka.png');
  await page.screenshot({ path: out, fullPage: false });
  console.log(`saved ${out}`);
} finally {
  await browser.close();
  await server.close();
}

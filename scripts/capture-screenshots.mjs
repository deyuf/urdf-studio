// Refresh the README screenshots in media/screenshots-web/ using the
// Franka primitives fixture. Captures three views:
//   12-editor-franka.png       — Source tab inside the default split layout
//   13-editor-fullscreen.png   — Same source, fullscreen mode with the
//                                viewport in the corner PIP
//   14-checks-health.png       — Checks tab with the health score badge
//
// We capture at 1440×900, then crop to the workspace area so the
// README images focus on the UI instead of dark padding around it.
//
//   node scripts/capture-screenshots.mjs

import { chromium } from 'playwright';
import { createReadStream, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'media', 'screenshots-web');
mkdirSync(OUT_DIR, { recursive: true });

const FRANKA = path.join(ROOT, 'test', 'fixtures', 'franka_primitives.urdf');
const urdf = readFileSync(FRANKA, 'utf-8');

async function startStaticServer(root) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const filePath = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!filePath.startsWith(root) || !existsSync(filePath)) { res.writeHead(404); res.end('not found'); return; }
    const ct = filePath.endsWith('.js') ? 'text/javascript'
      : filePath.endsWith('.css') ? 'text/css'
      : filePath.endsWith('.png') ? 'image/png' : 'text/html';
    res.writeHead(200, { 'content-type': ct });
    createReadStream(filePath).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  return { url: `http://127.0.0.1:${addr.port}`, close: () => new Promise(r => server.close(r)) };
}

function buildLoadRobotMessage() {
  // Each link in franka_primitives.urdf declares an <inertial> block.
  // Populate the synthetic metadata with a placeholder inertial so the
  // renderer's lint rule P-001 ("link missing inertial") doesn't fire
  // and skew the health score on the demo screenshot.
  const placeholderInertial = {
    mass: 1, origin: [0, 0, 0], rotation: [0, 0, 0],
    ixx: 0.01, ixy: 0, ixz: 0, iyy: 0.01, iyz: 0, izz: 0.01
  };
  const links = {};
  for (const m of urdf.matchAll(/<link\s+name="([^"]+)"/g)) {
    links[m[1]] = { name: m[1], childJoints: [], line: 0, inertial: placeholderInertial };
  }
  const joints = {};
  // Walk joints, capturing parent/child so the kinematic chain is real
  // and the viewport renders the connected arm.
  for (const block of urdf.matchAll(/<joint\s+name="([^"]+)"\s+type="([^"]+)"[\s\S]*?<\/joint>/g)) {
    const name = block[1];
    const type = block[2];
    const body = block[0];
    const parent = /<parent\s+link="([^"]+)"/.exec(body)?.[1];
    const child = /<child\s+link="([^"]+)"/.exec(body)?.[1];
    const lower = parseFloat(/lower="([^"]+)"/.exec(body)?.[1] ?? 'NaN');
    const upper = parseFloat(/upper="([^"]+)"/.exec(body)?.[1] ?? 'NaN');
    const effort = parseFloat(/effort="([^"]+)"/.exec(body)?.[1] ?? 'NaN');
    const velocity = parseFloat(/velocity="([^"]+)"/.exec(body)?.[1] ?? 'NaN');
    joints[name] = {
      name, type,
      parent, child,
      axis: [0, 0, 1],
      limit: {
        ...(Number.isFinite(lower) ? { lower } : {}),
        ...(Number.isFinite(upper) ? { upper } : {}),
        ...(Number.isFinite(effort) ? { effort } : {}),
        ...(Number.isFinite(velocity) ? { velocity } : {})
      },
      line: 0
    };
    if (parent && links[parent]) links[parent].childJoints.push(name);
    if (child && links[child]) links[child].parentJoint = name;
  }
  // Build a tree from fr3_link0.
  function buildTree(name) {
    return {
      link: name,
      children: (links[name]?.childJoints ?? [])
        .map(j => ({ joint: j, ...buildTree(joints[j].child) }))
    };
  }
  return {
    type: 'loadRobot',
    fileName: 'fr3_primitives.urdf',
    sourcePath: 'fr3_primitives.urdf',
    sourceBaseUri: '',
    format: 'urdf', urdf,
    packageMap: {},
    metadata: {
      robotName: 'fr3_primitives',
      counts: {
        links: Object.keys(links).length,
        joints: Object.keys(joints).length,
        movableJoints: Object.values(joints).filter(j => j.type !== 'fixed').length,
        visualMeshes: 0, collisionMeshes: 0
      },
      links, joints,
      meshes: [],
      rootLinks: ['fr3_link0'],
      movableJointNames: Object.keys(joints).filter(n => joints[n].type !== 'fixed'),
      tree: [buildTree('fr3_link0')],
      diagnostics: []
    },
    semantic: { groups: [], states: [], disableCollisions: [], diagnostics: [] },
    diagnostics: [],
    xacroArgs: [], xacroArgValues: {},
    renderSettings: { renderMode: 'visual', upAxis: '+Z' }
  };
}

const server = await startStaticServer(ROOT);
const browser = await chromium.launch();
// Capture at a tighter 1280×800 — feels more like a typical user window
// and produces less dead space in the screenshots.
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark', deviceScaleFactor: 2 });
const page = await ctx.newPage();
try {
  await page.goto(`${server.url}/test/renderer/harness.html`);
  // The harness itself only loads media/styles.css + editor.css (the
  // chrome VS Code provides). For the README screenshots we want the
  // web app's palette, so we inject web.css after the page loads.
  await page.addStyleTag({ url: `${server.url}/dist/media/web.css` });
  await page.waitForFunction(() => Array.isArray(window.__messages) && window.__messages.some(m => m?.type === 'ready'), { timeout: 30_000 });
  await page.evaluate(payload => window.dispatchEvent(new MessageEvent('message', { data: payload })), buildLoadRobotMessage());
  // Wait for joint sliders to appear (3D + panels mounted).
  await page.waitForSelector('[data-joint-slider]');
  // Pose the arm a little so the PIP / split view shows something
  // beyond the home pose. Range sliders don't accept Playwright's
  // text-style `fill()` — set the value directly and dispatch an input
  // event so the renderer's slider listeners pick it up.
  await page.evaluate(() => {
    const set = (name, value) => {
      const el = document.querySelector(`[data-joint-slider="${name}"]`);
      if (!el) return;
      el.value = String(value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
    };
    set('fr3_joint2', 0.6);
    set('fr3_joint4', -1.3);
    set('fr3_joint6', 1.6);
  });
  await page.waitForTimeout(700);

  // ---------------------------------------------------------------------
  // 12 — Source editor inside the default split layout.
  // ---------------------------------------------------------------------
  await page.locator('[data-tab="source"]').click();
  await page.waitForSelector('#panel-source .cm-editor');
  await page.waitForTimeout(400);
  // Crop to the .shell container so we don't include the harness body
  // padding.
  const shell = await page.locator('.shell').boundingBox();
  await page.screenshot({
    path: path.join(OUT_DIR, '12-editor-franka.png'),
    clip: shell ?? undefined
  });

  // ---------------------------------------------------------------------
  // 13 — Source editor fullscreen (F11 mode).
  // ---------------------------------------------------------------------
  await page.evaluate(() => {
    document.querySelector('#panel-source').dispatchEvent(
      new CustomEvent('urdf-studio:request-fullscreen-toggle', { bubbles: true })
    );
  });
  await page.waitForTimeout(500);
  const shellFs = await page.locator('.shell').boundingBox();
  await page.screenshot({
    path: path.join(OUT_DIR, '13-editor-fullscreen.png'),
    clip: shellFs ?? undefined
  });

  // Back to default layout.
  await page.evaluate(() => {
    document.querySelector('#panel-source').dispatchEvent(
      new CustomEvent('urdf-studio:request-fullscreen-toggle', { bubbles: true })
    );
  });
  await page.waitForTimeout(300);

  // ---------------------------------------------------------------------
  // 14 — Checks panel with the health score.
  // ---------------------------------------------------------------------
  await page.locator('[data-tab="checks"]').click();
  await page.waitForSelector('#panel-checks .health-score');
  await page.waitForTimeout(300);
  const shellCk = await page.locator('.shell').boundingBox();
  await page.screenshot({
    path: path.join(OUT_DIR, '14-checks-health.png'),
    clip: shellCk ?? undefined
  });

  console.log('Saved 12, 13, 14 (cropped to .shell, deviceScaleFactor 2).');
} finally {
  await browser.close();
  await server.close();
}

// Generate the five "latest-UI" web screenshots used by the README.
//
//   01-hero.png            — main view: joints panel + posed 3D arm
//   02-editor-split.png    — source editor in the default split layout
//   03-editor-fullscreen.png — source editor in fullscreen + corner PIP
//   04-checks-health.png   — checks panel with health score
//   05-diagnostics-toast.png — error toast (broken URDF surfaces errors)
//
// All captures use the in-repo renderer harness with web.css injected for
// palette parity with the real urdf.deyuf.org app. Run:
//
//   npm run compile && node scripts/capture-screenshots.mjs

import { chromium } from 'playwright';
import { createReadStream, existsSync, readFileSync, mkdirSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'media', 'screenshots-web');
mkdirSync(OUT_DIR, { recursive: true });

// Clean out any previously-generated web screenshots so trimming the set
// is a single source of truth. We keep only what this script emits.
for (const file of readdirSync(OUT_DIR)) {
  if (file.endsWith('.png')) unlinkSync(path.join(OUT_DIR, file));
}

async function startStaticServer(root) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const filePath = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (!filePath.startsWith(root) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
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

function buildLoadRobotMessage(urdfPath, opts = {}) {
  const urdf = readFileSync(urdfPath, 'utf-8');
  // Healthy fixtures: stamp a placeholder inertial so the P-001
  // ("missing inertial") rule doesn't fire on the synthetic metadata
  // and skew the demo health score. Broken fixtures: leave links
  // inertial-less so the showcase actually trips diagnostics.
  const stampInertial = opts.stampInertial !== false;
  const placeholderInertial = stampInertial ? {
    mass: 1, origin: [0, 0, 0], rotation: [0, 0, 0],
    ixx: 0.01, ixy: 0, ixz: 0, iyy: 0.01, iyz: 0, izz: 0.01
  } : undefined;
  const links = {};
  for (const m of urdf.matchAll(/<link\s+name="([^"]+)"/g)) {
    const entry = { name: m[1], childJoints: [], line: 0 };
    if (placeholderInertial) entry.inertial = placeholderInertial;
    links[m[1]] = entry;
  }
  const joints = {};
  for (const block of urdf.matchAll(/<joint\s+name="([^"]+)"\s+type="([^"]+)"[\s\S]*?<\/joint>/g)) {
    const name = block[1];
    const type = block[2];
    const body = block[0];
    const parent = /<parent\s+link="([^"]+)"/.exec(body)?.[1];
    const child = /<child\s+link="([^"]+)"/.exec(body)?.[1];
    const num = name2 => {
      const m = new RegExp(`${name2}="([^"]+)"`).exec(body);
      const v = m ? parseFloat(m[1]) : NaN;
      return Number.isFinite(v) ? v : undefined;
    };
    joints[name] = {
      name, type, parent, child,
      axis: [0, 0, 1],
      limit: {
        ...(num('lower') !== undefined ? { lower: num('lower') } : {}),
        ...(num('upper') !== undefined ? { upper: num('upper') } : {}),
        ...(num('effort') !== undefined ? { effort: num('effort') } : {}),
        ...(num('velocity') !== undefined ? { velocity: num('velocity') } : {})
      },
      line: 0
    };
    if (parent && links[parent]) links[parent].childJoints.push(name);
    if (child && links[child]) links[child].parentJoint = name;
  }
  // franka_broken.urdf intentionally contains a kinematic cycle — guard
  // the recursion with a seen-set so the screenshot script doesn't blow
  // the stack while still producing a usable tree.
  function buildTree(name, seen = new Set()) {
    if (!name || seen.has(name)) return { link: name ?? '?', children: [] };
    const next = new Set(seen); next.add(name);
    return {
      link: name,
      children: (links[name]?.childJoints ?? [])
        .filter(j => joints[j]?.child)
        .map(j => ({ joint: j, ...buildTree(joints[j].child, next) }))
    };
  }
  const rootLink = Object.keys(links).find(n => !links[n].parentJoint) ?? Object.keys(links)[0];
  return {
    type: 'loadRobot',
    fileName: path.basename(urdfPath),
    sourcePath: urdfPath,
    sourceBaseUri: '',
    format: 'urdf',
    urdf,
    packageMap: {},
    metadata: {
      robotName: opts.robotName ?? path.basename(urdfPath, '.urdf'),
      counts: {
        links: Object.keys(links).length,
        joints: Object.keys(joints).length,
        movableJoints: Object.values(joints).filter(j => j.type !== 'fixed').length,
        visualMeshes: 0, collisionMeshes: 0
      },
      links, joints,
      meshes: [],
      rootLinks: [rootLink],
      movableJointNames: Object.keys(joints).filter(n => joints[n].type !== 'fixed'),
      tree: [buildTree(rootLink)],
      diagnostics: opts.extraDiagnostics ?? []
    },
    semantic: { groups: [], states: [], disableCollisions: [], diagnostics: [] },
    diagnostics: opts.extraDiagnostics ?? [],
    xacroArgs: [], xacroArgValues: {},
    renderSettings: { renderMode: 'visual', upAxis: '+Z' }
  };
}

async function loadAndPose(page, payload, poseEdits = {}, { waitForJoints = true } = {}) {
  await page.evaluate(p => window.dispatchEvent(new MessageEvent('message', { data: p })), payload);
  if (waitForJoints) {
    // For sane URDFs the joints panel mounts immediately. The broken
    // fixture intentionally trips URDFLoader so the joint sliders never
    // materialise — callers can opt out.
    await page.waitForSelector('[data-joint-slider]', { timeout: 10_000 }).catch(() => undefined);
  }
  if (Object.keys(poseEdits).length > 0) {
    await page.evaluate(edits => {
      for (const [name, value] of Object.entries(edits)) {
        const el = document.querySelector(`[data-joint-slider="${name}"]`);
        if (!el) return;
        el.value = String(value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, poseEdits);
  }
  await page.waitForTimeout(700);
}

const FRANKA_PRIMITIVES = path.join(ROOT, 'test', 'fixtures', 'franka_primitives.urdf');
const FRANKA_BROKEN = path.join(ROOT, 'test', 'fixtures', 'franka_broken.urdf');

const server = await startStaticServer(ROOT);
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: 'dark', deviceScaleFactor: 2 });
const page = await ctx.newPage();

const POSE = { fr3_joint2: 0.6, fr3_joint4: -1.3, fr3_joint6: 1.6 };

async function reset() {
  await page.goto(`${server.url}/test/renderer/harness.html`);
  await page.addStyleTag({ url: `${server.url}/dist/media/web.css` });
  await page.waitForFunction(() => Array.isArray(window.__messages) && window.__messages.some(m => m?.type === 'ready'), { timeout: 30_000 });
}

async function snap(name) {
  const shell = await page.locator('.shell').boundingBox();
  await page.screenshot({ path: path.join(OUT_DIR, name), clip: shell ?? undefined });
}

try {
  // -------- 01 hero: posed arm + joints panel ----------------------------
  await reset();
  await loadAndPose(page, buildLoadRobotMessage(FRANKA_PRIMITIVES), POSE);
  await page.locator('[data-tab="joints"]').click();
  await snap('01-hero.png');

  // -------- 02 editor split ---------------------------------------------
  await page.locator('[data-tab="source"]').click();
  await page.waitForSelector('#panel-source .cm-editor');
  await page.waitForTimeout(400);
  await snap('02-editor-split.png');

  // -------- 03 editor fullscreen ----------------------------------------
  await page.evaluate(() => {
    document.querySelector('#panel-source').dispatchEvent(
      new CustomEvent('urdf-studio:request-fullscreen-toggle', { bubbles: true })
    );
  });
  await page.waitForTimeout(400);
  await snap('03-editor-fullscreen.png');
  // Back out
  await page.evaluate(() => {
    document.querySelector('#panel-source').dispatchEvent(
      new CustomEvent('urdf-studio:request-fullscreen-toggle', { bubbles: true })
    );
  });
  await page.waitForTimeout(200);

  // -------- 04 checks panel (clean fixture, 100 health) ------------------
  await page.locator('[data-tab="checks"]').click();
  await page.waitForSelector('#panel-checks .health-score');
  await page.waitForTimeout(200);
  await snap('04-checks-health.png');

  // -------- 05 diagnostics-rich view (broken fixture) --------------------
  await reset();
  await loadAndPose(
    page,
    buildLoadRobotMessage(FRANKA_BROKEN, { robotName: 'fr3_broken', stampInertial: false }),
    {},
    { waitForJoints: false }
  );
  await page.locator('[data-tab="checks"]').click();
  await page.waitForSelector('#panel-checks .health-score', { timeout: 10_000 });
  await page.waitForTimeout(400);
  await snap('05-diagnostics-broken.png');

  console.log('Saved 5 screenshots (01-hero, 02-editor-split, 03-editor-fullscreen, 04-checks-health, 05-diagnostics-broken).');
} finally {
  await browser.close();
  await server.close();
}

// Regenerate every web-facing screenshot used by the README, using the
// real web app (dist-web) driven by Playwright. The Franka FR3 hero is
// captured as an animated GIF; the other four key-feature views are PNGs.
//
//   01-hero.gif / .png      — real FR3 walks through pose → Source →
//                             Checks → Joints (poster PNG for fallback)
//   02-editor-split.png     — CodeMirror 6 source editor (split layout)
//   03-editor-fullscreen.png — source editor fullscreen + corner PIP
//   04-checks-health.png    — Checks panel with health score
//   05-diagnostics-broken.png — broken URDF surfaces lint findings + toast
//
// Run order:
//   npm run web:build
//   FRANKA_DIR=test/fixtures/franka_description \
//     node scripts/capture-screenshots.mjs
//
// Meshes are NOT vendored into the repo (189MB) — clone the real
// franka_description into test/fixtures/franka_description/meshes when
// regenerating, or set FRANKA_DIR to a full checkout elsewhere.

import { chromium } from 'playwright';
import { createReadStream, existsSync, statSync, mkdirSync, readdirSync, unlinkSync, renameSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'media', 'screenshots-web');
const DIST_WEB = path.join(ROOT, 'dist-web');
const FRANKA_DIR = path.resolve(ROOT, process.env.FRANKA_DIR ?? 'test/fixtures/franka_description');
const BROKEN_DIR = path.join(ROOT, 'test', 'fixtures');  // contains franka_broken.urdf

mkdirSync(OUT_DIR, { recursive: true });

if (!existsSync(path.join(DIST_WEB, 'app.js'))) {
  console.error('dist-web/app.js missing — run `npm run web:build` first.');
  process.exit(1);
}
if (!existsSync(path.join(FRANKA_DIR, 'package.xml'))) {
  console.error(`FRANKA_DIR=${FRANKA_DIR} does not contain package.xml.`);
  process.exit(1);
}

// Clean prior outputs so the screenshot set is exactly what this script
// produces — no orphan leftovers from older runs.
for (const file of readdirSync(OUT_DIR)) {
  if (/\.(png|gif|webm)$/.test(file)) unlinkSync(path.join(OUT_DIR, file));
}
const TMP_VIDEO_DIR = path.join(ROOT, 'tmp', 'screenshots-recording');
rmSync(TMP_VIDEO_DIR, { recursive: true, force: true });
mkdirSync(TMP_VIDEO_DIR, { recursive: true });

// ---- static server --------------------------------------------------------
async function startStaticServer(root) {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    let filePath = path.resolve(root, '.' + decodeURIComponent(url.pathname));
    if (existsSync(filePath) && statSync(filePath).isDirectory()) {
      filePath = path.join(filePath, 'index.html');
    }
    if (!filePath.startsWith(root) || !existsSync(filePath)) {
      res.writeHead(404); res.end('not found'); return;
    }
    const ct = filePath.endsWith('.js') ? 'text/javascript'
      : filePath.endsWith('.css') ? 'text/css'
      : filePath.endsWith('.png') ? 'image/png'
      : filePath.endsWith('.html') ? 'text/html'
      : 'application/octet-stream';
    res.writeHead(200, { 'content-type': ct });
    createReadStream(filePath).pipe(res);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  return { url: `http://127.0.0.1:${addr.port}`, close: () => new Promise(r => server.close(r)) };
}

// ---- shared helpers -------------------------------------------------------
function ffmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn('ffmpeg', ['-y', ...args], { stdio: 'inherit' });
    p.on('exit', code => code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)));
  });
}

async function openShell(page, serverUrl) {
  await page.goto(serverUrl);
  await page.locator('#topbar').waitFor({ state: 'visible', timeout: 10_000 });
  // Dismiss onboarding tour if present.
  await page.locator('dialog.onboarding [data-action="skip"]').click({ timeout: 2000 }).catch(() => undefined);
}

async function pickXacroFile(page, fixtureDir, xacroBasename) {
  await page.setInputFiles('#file-input', fixtureDir);
  await page.locator('#file-select').waitFor({ state: 'visible', timeout: 30_000 });
  const target = await page.locator('#file-select option').evaluateAll((opts, name) => {
    const found = opts.find(o => o.value.endsWith(name));
    return found ? found.value : '';
  }, xacroBasename);
  if (!target) throw new Error(`${xacroBasename} not in file index`);
  await page.locator('#file-select').selectOption(target);
}

async function waitForRobotStable(page, jointName = 'fr3_joint1') {
  await page.locator(`[data-joint-slider="${jointName}"]`).waitFor({ timeout: 60_000 });
  // Hold until the topbar status clears (mesh streaming done).
  await page.waitForFunction(() => {
    const status = document.querySelector('#topbar-status');
    if (!status) return true;
    return status.hidden || (status.getAttribute('data-kind') ?? '') !== 'progress';
  }, null, { timeout: 60_000, polling: 200 });
  await page.waitForTimeout(2000);
}

function tween(from, to, t) { return from + (to - from) * t; }

async function animateBetween(page, from, to, steps, perStepMs) {
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    const pose = {};
    for (const k of Object.keys(to)) pose[k] = tween(from[k] ?? 0, to[k], eased);
    await page.evaluate(p => {
      for (const [name, value] of Object.entries(p)) {
        const el = document.querySelector(`[data-joint-slider="${name}"]`);
        if (!el) continue;
        el.value = String(value);
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
    }, pose);
    await page.waitForTimeout(perStepMs);
  }
}

async function snap(page, name) {
  await page.screenshot({ path: path.join(OUT_DIR, name) });
}

// =============================================================================
//                              HERO (GIF)
// =============================================================================
async function captureHero(serverUrl, browser) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: 'dark',
    recordVideo: { dir: TMP_VIDEO_DIR, size: { width: 1280, height: 800 } }
  });
  const page = await ctx.newPage();
  await openShell(page, serverUrl);
  await pickXacroFile(page, FRANKA_DIR, 'fr3.urdf.xacro');
  await waitForRobotStable(page);

  // -- act 1: pose ----------------------------------------------------------
  let current = { fr3_joint2: 0, fr3_joint4: 0, fr3_joint6: 0 };
  const POSES = [
    { fr3_joint2: 0.2,  fr3_joint4: -0.6, fr3_joint6: 1.4 },
    { fr3_joint2: 0.8,  fr3_joint4: -1.5, fr3_joint6: 2.4 },
    { fr3_joint2: -0.4, fr3_joint4: -2.2, fr3_joint6: 1.0 },
    { fr3_joint2: 0.5,  fr3_joint4: -1.0, fr3_joint6: 1.8 }
  ];
  for (const pose of POSES) {
    await animateBetween(page, current, pose, 18, 30);
    current = pose;
    await page.waitForTimeout(250);
  }
  // -- act 2: Source tab ----------------------------------------------------
  await page.locator('.tab[data-tab="source"]').click();
  await page.locator('#panel-source .cm-editor').waitFor({ timeout: 5000 });
  await page.waitForTimeout(1400);
  // -- act 3: Checks tab ----------------------------------------------------
  await page.locator('.tab[data-tab="checks"]').click();
  await page.waitForTimeout(1400);
  // -- act 4: back to Joints + last move -----------------------------------
  await page.locator('.tab[data-tab="joints"]').click();
  await page.waitForTimeout(400);
  await animateBetween(page, current, POSES[1], 20, 35);
  await page.waitForTimeout(500);

  await ctx.close();

  const webm = readdirSync(TMP_VIDEO_DIR).find(f => f.endsWith('.webm'));
  if (!webm) throw new Error('No webm produced');
  const webmPath = path.join(TMP_VIDEO_DIR, webm);
  const gifPath = path.join(OUT_DIR, '01-hero.gif');
  const palettePath = path.join(TMP_VIDEO_DIR, 'palette.png');
  const FPS = 10;
  const WIDTH = 800;
  await ffmpeg([
    '-i', webmPath,
    '-vf', `fps=${FPS},scale=${WIDTH}:-1:flags=lanczos,palettegen=stats_mode=diff`,
    palettePath
  ]);
  await ffmpeg([
    '-i', webmPath,
    '-i', palettePath,
    '-lavfi', `fps=${FPS},scale=${WIDTH}:-1:flags=lanczos [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
    gifPath
  ]);
  const posterPath = path.join(OUT_DIR, '01-hero.png');
  await ffmpeg([
    '-ss', '4.0',
    '-i', webmPath,
    '-frames:v', '1',
    '-update', '1',
    '-vf', 'scale=1280:-1',
    posterPath
  ]);
  renameSync(webmPath, path.join(OUT_DIR, '01-hero.webm'));
}

// =============================================================================
//                           STATIC SCREENSHOTS
// =============================================================================
async function captureStatic(serverUrl, browser) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: 'dark',
    deviceScaleFactor: 2
  });
  const page = await ctx.newPage();
  await openShell(page, serverUrl);
  await pickXacroFile(page, FRANKA_DIR, 'fr3.urdf.xacro');
  await waitForRobotStable(page);

  // Drive to a recognisable pose for the static shots.
  await animateBetween(
    page,
    { fr3_joint2: 0, fr3_joint4: 0, fr3_joint6: 0 },
    { fr3_joint2: 0.6, fr3_joint4: -1.3, fr3_joint6: 1.6 },
    12, 30
  );
  await page.waitForTimeout(400);

  // -- 02 editor split ------------------------------------------------------
  await page.locator('.tab[data-tab="source"]').click();
  await page.locator('#panel-source .cm-editor').waitFor({ timeout: 5000 });
  await page.waitForTimeout(700);
  await snap(page, '02-editor-split.png');

  // -- 03 editor fullscreen -------------------------------------------------
  await page.evaluate(() => {
    document.querySelector('#panel-source').dispatchEvent(
      new CustomEvent('urdf-studio:request-fullscreen-toggle', { bubbles: true })
    );
  });
  await page.waitForTimeout(500);
  await snap(page, '03-editor-fullscreen.png');
  // Exit fullscreen.
  await page.evaluate(() => {
    document.querySelector('#panel-source').dispatchEvent(
      new CustomEvent('urdf-studio:request-fullscreen-toggle', { bubbles: true })
    );
  });
  await page.waitForTimeout(200);

  // -- 04 checks panel ------------------------------------------------------
  await page.locator('.tab[data-tab="checks"]').click();
  await page.waitForSelector('#panel-checks .health-score', { timeout: 5000 });
  await page.waitForTimeout(300);
  await snap(page, '04-checks-health.png');

  await ctx.close();
}

// =============================================================================
//                       DIAGNOSTICS / BROKEN FIXTURE
// =============================================================================
async function captureDiagnostics(serverUrl, browser) {
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: 'dark',
    deviceScaleFactor: 2
  });
  const page = await ctx.newPage();
  await openShell(page, serverUrl);
  // Use the test/fixtures folder for the broken URDF — that gives us the
  // franka_broken.urdf entry in the file picker.
  await page.setInputFiles('#file-input', BROKEN_DIR);
  await page.locator('#file-select').waitFor({ state: 'visible', timeout: 30_000 });
  const target = await page.locator('#file-select option').evaluateAll(opts => {
    const found = opts.find(o => o.value.endsWith('franka_broken.urdf'));
    return found ? found.value : '';
  });
  if (!target) throw new Error('franka_broken.urdf not in file index');
  await page.locator('#file-select').selectOption(target);
  // Broken URDF: do NOT wait for the joint slider — the parser bails.
  // The error toast and Checks panel populate regardless.
  await page.waitForTimeout(3500);
  await page.locator('.tab[data-tab="checks"]').click();
  await page.waitForSelector('#panel-checks .health-score', { timeout: 10_000 });
  await page.waitForTimeout(400);
  await snap(page, '05-diagnostics-broken.png');
  await ctx.close();
}

// ---- main ------------------------------------------------------------------
const server = await startStaticServer(DIST_WEB);
const browser = await chromium.launch();
try {
  await captureHero(server.url, browser);
  await captureStatic(server.url, browser);
  await captureDiagnostics(server.url, browser);
  console.log(`Saved:\n  ${readdirSync(OUT_DIR).filter(f => /\.(png|gif|webm)$/.test(f)).sort().join('\n  ')}`);
} finally {
  await browser.close();
  await server.close();
}

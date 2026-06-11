// Regression tests for host→renderer message delivery.
//
// The VS Code webview does NOT deliver extension messages on the renderer's
// own window: the extension posts into the webview wrapper, whose PARENT
// frame relays the message into the content iframe. From the renderer's
// perspective that is `event.source === window.parent` with a foreign origin.
// A `source !== window` origin check therefore silently drops every host
// message — loadRobot never arrives and the preview sits at
// "Waiting for robot..." forever. These tests pin the accepted delivery paths.

import { expect, test } from '@playwright/test';
import { createReadStream, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIST_WEB = path.join(REPO_ROOT, 'dist-web');
const FRANKA_FIXTURE_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'franka_description');

const LOAD_ROBOT_MESSAGE = {
  type: 'loadRobot',
  fileName: 'fixture.urdf',
  sourcePath: 'fixture.urdf',
  sourceBaseUri: '',
  format: 'urdf',
  urdf: `<?xml version="1.0"?>
    <robot name="fixture">
      <link name="base">
        <visual><geometry><box size="0.5 0.2 0.2"/></geometry></visual>
      </link>
      <link name="tip">
        <visual><origin xyz="0.6 0 0"/><geometry><box size="0.2 0.2 0.2"/></geometry></visual>
      </link>
      <joint name="joint1" type="revolute">
        <parent link="base"/><child link="tip"/><axis xyz="0 0 1"/>
        <limit lower="-1" upper="1" effort="1" velocity="1"/>
      </joint>
    </robot>`,
  packageMap: {},
  metadata: {
    robotName: 'fixture',
    counts: { links: 2, joints: 1, movableJoints: 1, visualMeshes: 0, collisionMeshes: 0 },
    links: { base: { name: 'base', childJoints: ['joint1'] }, tip: { name: 'tip', parentJoint: 'joint1', childJoints: [] } },
    joints: { joint1: { name: 'joint1', type: 'revolute', parent: 'base', child: 'tip', axis: [0, 0, 1], limit: { lower: -1, upper: 1 } } },
    meshes: [],
    rootLinks: ['base'],
    movableJointNames: ['joint1'],
    tree: [{ link: 'base', children: [{ link: 'tip', joint: 'joint1', children: [] }] }],
    diagnostics: []
  },
  semantic: { groups: [], states: [], diagnostics: [] },
  diagnostics: [],
  xacroArgs: [],
  xacroArgValues: {},
  renderSettings: { renderMode: 'visual', upAxis: '+Z' }
};

test('renderer accepts loadRobot relayed by the PARENT frame (VS Code webview delivery)', async ({ page }) => {
  const server = await startStaticServer(REPO_ROOT);
  try {
    // Embed the renderer harness in an iframe and drive it from the parent —
    // the same window topology VS Code uses. The parent page lives on
    // about:blank, so inside the iframe event.source === window.parent and
    // event.origin differs from the iframe's own origin, exactly like the
    // extension host relay.
    await page.setContent(`<iframe id="webview" src="${server.url}/test/renderer/harness.html" style="width:1000px;height:700px"></iframe>`);

    const frame = page.frame({ url: /harness\.html/ });
    expect(frame, 'harness iframe must attach').toBeTruthy();

    await frame!.waitForFunction(
      () => Array.isArray((window as unknown as { __messages?: Array<{ type?: string }> }).__messages)
        && (window as unknown as { __messages: Array<{ type?: string }> }).__messages.some(message => message.type === 'ready'),
      undefined,
      { timeout: 30_000 }
    );

    // Post from the PARENT context into the iframe — source becomes the
    // parent window, not the iframe's own window.
    await page.evaluate(message => {
      const iframe = document.getElementById('webview') as HTMLIFrameElement;
      iframe.contentWindow!.postMessage(message, '*');
    }, LOAD_ROBOT_MESSAGE);

    await expect(frame!.locator('[data-joint-slider="joint1"]')).toBeVisible({ timeout: 15_000 });
    const hud = await frame!.locator('#hud').textContent();
    expect(hud).not.toContain('Waiting for robot');
  } finally {
    await server.close();
  }
});

test('renderer still rejects messages from a foreign (non-parent) window', async ({ page }) => {
  const server = await startStaticServer(REPO_ROOT);
  try {
    // Two sibling iframes: a hostile frame posting into the harness frame.
    // The harness sees source === the SIBLING window (neither itself nor its
    // parent) — the renderer must drop it.
    await page.setContent(`
      <iframe id="webview" src="${server.url}/test/renderer/harness.html" style="width:1000px;height:700px"></iframe>
      <iframe id="attacker" src="about:blank"></iframe>
    `);
    const frame = page.frame({ url: /harness\.html/ });
    expect(frame).toBeTruthy();
    await frame!.waitForFunction(
      () => Array.isArray((window as unknown as { __messages?: Array<{ type?: string }> }).__messages)
        && (window as unknown as { __messages: Array<{ type?: string }> }).__messages.some(message => message.type === 'ready'),
      undefined,
      { timeout: 30_000 }
    );

    // Run the postMessage INSIDE the attacker frame so the message source is
    // the sibling window (neither the harness window nor its parent).
    const attacker = page.frames().find(f => f !== page.mainFrame() && !/harness\.html/.test(f.url()));
    expect(attacker).toBeTruthy();
    await attacker!.evaluate(message => {
      const target = (window.parent.document.getElementById('webview') as HTMLIFrameElement).contentWindow!;
      target.postMessage(JSON.parse(message), '*');
    }, JSON.stringify(LOAD_ROBOT_MESSAGE));

    // Give the renderer a beat; the robot must NOT load.
    await page.waitForTimeout(1500);
    await expect(frame!.locator('[data-joint-slider="joint1"]')).toHaveCount(0);
    const hud = await frame!.locator('#hud').textContent();
    expect(hud).toContain('Waiting for robot');
  } finally {
    await server.close();
  }
});

test.describe('Franka FR3 (web shell, full xacro pipeline)', () => {
  let server: { url: string; close(): Promise<void> } | undefined;

  test.beforeAll(async () => {
    if (!existsSync(path.join(DIST_WEB, 'app.js'))) {
      throw new Error('Run `npm run web:build` before the web shell tests.');
    }
    server = await startStaticServer(DIST_WEB);
  });

  test.afterAll(async () => {
    await server?.close();
  });

  test('loads fr3.urdf.xacro, reveals the robot, and drives fr3_joint1', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'webkitdirectory only on chromium.');

    await page.goto(server!.url);
    await expect(page.locator('#topbar')).toBeVisible();
    await page.setInputFiles('#file-input', FRANKA_FIXTURE_DIR);
    await expect(page.locator('#file-select')).toBeEnabled({ timeout: 15_000 });

    const targetValue = await page.locator('#file-select option').evaluateAll(options => {
      const target = options.find(option => /robots\/fr3\/fr3\.urdf\.xacro$/.test((option as HTMLOptionElement).value));
      return target ? (target as HTMLOptionElement).value : '';
    });
    expect(targetValue, 'fr3.urdf.xacro must be among the indexed files').not.toEqual('');
    await page.locator('#file-select').selectOption(targetValue);

    // Full xacro expansion of the real franka_description takes a moment.
    await expect(page.locator('[data-joint-slider="fr3_joint1"]')).toBeVisible({ timeout: 30_000 });

    // The fixture ships no mesh binaries, so meshes report as missing — but
    // the robot must still REVEAL (the HUD must leave "Waiting for robot...",
    // and the viewport must become visible). This pins the pending-mesh
    // reveal logic for the all-meshes-failed path.
    await expect(page.locator('#hud')).not.toContainText('Waiting for robot', { timeout: 30_000 });
    await expect(page.locator('#hud')).not.toContainText('Parsing robot', { timeout: 30_000 });
    await expect.poll(
      () => page.locator('canvas#viewport').evaluate(canvas => getComputedStyle(canvas).opacity),
      { timeout: 15_000 }
    ).toBe('1');

    // Drive a joint — slider must accept input and not throw. Range inputs
    // only accept values on the step grid (min -2.9007 + k*0.001), so use a
    // grid-aligned value rather than a round 0.5.
    await page.locator('[data-joint-slider="fr3_joint1"]').fill('0.4993');
    const hud = await page.locator('#hud').textContent();
    expect(hud).toContain('fr3');
  });
});

async function startStaticServer(root: string): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    let filePath = path.resolve(root, `.${decodeURIComponent(requestUrl.pathname)}`);
    if (requestUrl.pathname === '/' || requestUrl.pathname === '') {
      filePath = path.join(root, 'index.html');
    }
    if (!filePath.startsWith(root) || !existsSync(filePath)) {
      response.writeHead(404);
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': contentType(filePath) });
    createReadStream(filePath).pipe(response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Could not start renderer test server.');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>(resolve => server.close(() => resolve()))
  };
}

function contentType(filePath: string): string {
  if (filePath.endsWith('.js')) {
    return 'text/javascript';
  }
  if (filePath.endsWith('.css')) {
    return 'text/css';
  }
  return 'text/html';
}

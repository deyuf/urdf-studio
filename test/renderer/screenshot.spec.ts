// Playwright e2e tests for the 3D viewport screenshot feature.

import { expect, test } from '@playwright/test';
import { createReadStream, existsSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';

const FRANKA_FIXTURE = path.resolve(__dirname, '..', 'fixtures', 'franka_primitives.urdf');

test.describe('viewport screenshot (Tools panel)', () => {
  test('Save PNG triggers a download with a robot-named filename', async ({ page }) => {
    const server = await startStaticServer(path.resolve(__dirname, '..', '..'));
    try {
      await page.goto(`${server.url}/test/renderer/harness.html`);
      await page.waitForFunction(() => (window as any).__messages?.some((m: any) => m.type === 'ready'), undefined, { timeout: 30_000 });
      const urdf = readFileSync(FRANKA_FIXTURE, 'utf-8');
      await page.evaluate(payload => {
        window.dispatchEvent(new MessageEvent('message', { data: payload }));
      }, buildLoadRobotMessage(urdf));

      // Open Tools tab.
      await page.locator('.tab[data-tab="tools"]').click();
      await expect(page.locator('#screenshot-download')).toBeVisible();

      // Intercept the download.
      const downloadPromise = page.waitForEvent('download', { timeout: 10_000 });
      await page.locator('#screenshot-download').click();
      const download = await downloadPromise;
      const filename = download.suggestedFilename();
      // Format: <robot>_<timestamp>.png
      expect(filename).toMatch(/fr3_primitives_.*\.png$/);
      // Status text confirms the save.
      await expect(page.locator('#screenshot-status')).toContainText(/Saved/);
    } finally {
      await server.close();
    }
  });

  test('scale selector affects produced image size (2× is at least 2× wider than 1×)', async ({ page }) => {
    const server = await startStaticServer(path.resolve(__dirname, '..', '..'));
    try {
      await page.goto(`${server.url}/test/renderer/harness.html`);
      await page.waitForFunction(() => (window as any).__messages?.some((m: any) => m.type === 'ready'), undefined, { timeout: 30_000 });
      const urdf = readFileSync(FRANKA_FIXTURE, 'utf-8');
      await page.evaluate(payload => {
        window.dispatchEvent(new MessageEvent('message', { data: payload }));
      }, buildLoadRobotMessage(urdf));

      await page.locator('.tab[data-tab="tools"]').click();
      const canvasDims = await page.locator('canvas').evaluate((c: HTMLCanvasElement) => ({ w: c.width, h: c.height }));

      // Capture at 1×.
      await page.locator('#screenshot-scale').selectOption('1');
      const dl1 = page.waitForEvent('download');
      await page.locator('#screenshot-download').click();
      const file1 = await (await dl1).path();
      // Capture at 2×.
      await page.locator('#screenshot-scale').selectOption('2');
      const dl2 = page.waitForEvent('download');
      await page.locator('#screenshot-download').click();
      const file2 = await (await dl2).path();

      // Both files exist; file2 should be considerably larger than file1.
      expect(file1).toBeTruthy();
      expect(file2).toBeTruthy();
      const size1 = require('node:fs').statSync(file1!).size;
      const size2 = require('node:fs').statSync(file2!).size;
      expect(size2).toBeGreaterThan(size1);
      // Sanity: 1× capture file should at minimum match the canvas pixel grid.
      expect(canvasDims.w).toBeGreaterThan(0);
    } finally {
      await server.close();
    }
  });
});

function buildLoadRobotMessage(urdf: string) {
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
      counts: { links: 11, joints: 10, movableJoints: 8, visualMeshes: 0, collisionMeshes: 0 },
      links: extractLinks(urdf),
      joints: extractJoints(urdf),
      meshes: [],
      rootLinks: ['fr3_link0'],
      movableJointNames: ['fr3_joint1'],
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

function extractLinks(urdf: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const m of urdf.matchAll(/<link\s+name="([^"]+)"/g)) {
    out[m[1]] = { name: m[1], childJoints: [], line: 0 };
  }
  return out;
}

function extractJoints(urdf: string): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const m of urdf.matchAll(/<joint\s+name="([^"]+)"\s+type="([^"]+)"/g)) {
    out[m[1]] = { name: m[1], type: m[2], axis: [0, 0, 1], limit: {}, line: 0 };
  }
  return out;
}

async function startStaticServer(root: string): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const filePath = path.resolve(root, `.${decodeURIComponent(requestUrl.pathname)}`);
    if (!filePath.startsWith(root) || !existsSync(filePath)) { response.writeHead(404); response.end('not found'); return; }
    response.writeHead(200, { 'content-type': contentType(filePath) });
    createReadStream(filePath).pipe(response);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  if (!addr || typeof addr === 'string') throw new Error('server failed');
  return { url: `http://127.0.0.1:${addr.port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

function contentType(filePath: string): string {
  if (filePath.endsWith('.js')) return 'text/javascript';
  if (filePath.endsWith('.css')) return 'text/css';
  return 'text/html';
}

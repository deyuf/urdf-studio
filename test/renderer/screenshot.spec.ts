// Playwright e2e tests for the 3D viewport screenshot feature.

import { startStaticServer } from './helpers';
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
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

      expect(file1).toBeTruthy();
      expect(file2).toBeTruthy();
      // PNG IHDR stores the actual pixel dimensions independently of compression.
      const dimensions = (file: string) => {
        const bytes = readFileSync(file);
        expect(bytes.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
        expect(bytes.toString('ascii', 12, 16)).toBe('IHDR');
        return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
      };
      const one = dimensions(file1!);
      const two = dimensions(file2!);
      expect(one).toEqual({ width: canvasDims.w, height: canvasDims.h });
      expect(two).toEqual({ width: one.width * 2, height: one.height * 2 });
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

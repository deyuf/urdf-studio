import { expect, test, type Page } from '@playwright/test';
import path from 'node:path';
import { createReadStream, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';

test.describe('Phase A features', () => {
  let server: { url: string; close(): Promise<void> };

  test.beforeAll(async () => {
    server = await startStaticServer(path.resolve(__dirname, '..', '..'));
  });

  test.afterAll(async () => {
    await server.close();
  });

  async function loadFixture(page: Page): Promise<void> {
    await page.goto(`${server.url}/test/renderer/harness.html`);
    await page.waitForFunction(
      () => Array.isArray((window as any).__messages)
        && (window as any).__messages.some((message: any) => message.type === 'ready')
    );

    await page.evaluate(() => {
      const urdf = `<?xml version="1.0"?>
<robot name="bot">
  <link name="base">
    <visual><geometry><box size="0.2 0.2 0.2"/></geometry></visual>
    <inertial><mass value="1.0"/><inertia ixx="0.01" ixy="0" ixz="0" iyy="0.02" iyz="0" izz="0.03"/></inertial>
  </link>
  <link name="tip">
    <visual><origin xyz="0.2 0 0"/><geometry><box size="0.1 0.1 0.1"/></geometry></visual>
  </link>
  <joint name="hinge" type="revolute">
    <parent link="base"/><child link="tip"/><axis xyz="0 0 1"/>
    <limit lower="-1" upper="1" effort="1" velocity="1"/>
  </joint>
</robot>`;
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'loadRobot',
          fileName: 'bot.urdf',
          sourcePath: '/tmp/bot.urdf',
          sourceBaseUri: '',
          format: 'urdf',
          urdf,
          packageMap: {},
          metadata: {
            robotName: 'bot',
            counts: { links: 2, joints: 1, movableJoints: 1, visualMeshes: 0, collisionMeshes: 0 },
            links: {
              base: {
                name: 'base', childJoints: ['hinge'], line: 3,
                inertial: { mass: 1.0, origin: [0, 0, 0], rotation: [0, 0, 0], ixx: 0.01, ixy: 0, ixz: 0, iyy: 0.02, iyz: 0, izz: 0.03 }
              },
              tip: { name: 'tip', parentJoint: 'hinge', childJoints: [], line: 7 }
            },
            joints: {
              hinge: { name: 'hinge', type: 'revolute', parent: 'base', child: 'tip', axis: [0, 0, 1], limit: { lower: -1, upper: 1 }, line: 10 }
            },
            meshes: [],
            rootLinks: ['base'],
            movableJointNames: ['hinge'],
            tree: [{ link: 'base', children: [{ link: 'tip', joint: 'hinge', children: [] }] }],
            totalMass: 1.0,
            diagnostics: [
              { severity: 'warning', message: 'demo warning', code: 'demo.w', line: 5 }
            ]
          },
          semantic: { groups: [], states: [], disableCollisions: [], diagnostics: [] },
          diagnostics: [
            { severity: 'warning', message: 'demo warning', code: 'demo.w', line: 5 }
          ],
          xacroArgs: [],
          xacroArgValues: {},
          renderSettings: { renderMode: 'visual', upAxis: '+Z' }
        }
      }));
    });
    await expect(page.locator('[data-joint-slider="hinge"]')).toBeVisible();
  }

  test('Source tab renders the URDF with line numbers and highlights selected link', async ({ page }) => {
    await loadFixture(page);
    await page.locator('.tab[data-tab="source"]').click();
    await expect(page.locator('#panel-source .source-view')).toBeVisible();
    const lineCount = await page.locator('#panel-source .source-line').count();
    expect(lineCount).toBeGreaterThan(5);

    // Selecting "tip" from the Links tab should highlight line 7 in Source.
    await page.locator('.tab[data-tab="links"]').click();
    await page.locator('button[data-link="tip"]').click();
    await page.locator('.tab[data-tab="source"]').click();
    await expect(page.locator('#panel-source .source-line.active[data-source-line="7"]')).toHaveCount(1);
  });

  test('Labels mode toggles 3D label DOM in the labels layer', async ({ page }) => {
    await loadFixture(page);
    // Initially off: layer present but empty (or only hidden labels).
    await expect(page.locator('.labels-layer')).toBeAttached();
    const visibleBefore = await page.locator('.labels-layer .label-3d:visible').count();
    expect(visibleBefore).toBe(0);

    await page.locator('#labels-mode').selectOption('both');
    await expect(page.locator('.labels-layer .label-3d-joint')).not.toHaveCount(0);
    await expect(page.locator('.labels-layer .label-3d-link')).not.toHaveCount(0);
  });

  test('Tools tab exposes Measure and Export controls', async ({ page }) => {
    await loadFixture(page);
    await page.locator('.tab[data-tab="tools"]').click();
    await expect(page.locator('#measure-toggle')).toBeVisible();
    await expect(page.locator('#measure-clear')).toBeVisible();
    await expect(page.locator('#export-bom')).toBeVisible();
    await expect(page.locator('#export-report')).toBeVisible();

    // Clicking Start measuring flips the toggle label.
    const initial = await page.locator('#measure-toggle').textContent();
    await page.locator('#measure-toggle').click();
    const next = await page.locator('#measure-toggle').textContent();
    expect(next).not.toBe(initial);
    expect(next).toContain('Pick');
  });

  test('Export BOM posts a requestSaveBom message with CSV body', async ({ page }) => {
    await loadFixture(page);
    await page.locator('.tab[data-tab="tools"]').click();
    await page.locator('#export-bom').click();

    const message = await page.evaluate(() => {
      const messages = (window as any).__messages as Array<any>;
      return messages.find(m => m.type === 'requestSaveBom');
    });
    expect(message).toBeTruthy();
    expect(typeof message.csv).toBe('string');
    expect(message.csv).toContain('link,parent_joint');
    expect(message.csv).toContain('base');
    expect(message.csv).toContain('tip');
    expect(message.filename).toContain('bom.csv');
  });
});

async function startStaticServer(root: string): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let filePath = path.join(root, decodeURIComponent(url.pathname));
    if (filePath.endsWith('/')) {
      filePath = path.join(filePath, 'index.html');
    }
    if (!filePath.startsWith(root) || !existsSync(filePath)) {
      res.statusCode = 404;
      res.end();
      return;
    }
    res.statusCode = 200;
    if (filePath.endsWith('.js')) res.setHeader('content-type', 'text/javascript');
    else if (filePath.endsWith('.html')) res.setHeader('content-type', 'text/html');
    else if (filePath.endsWith('.css')) res.setHeader('content-type', 'text/css');
    createReadStream(filePath).pipe(res);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Failed to bind static server');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close(): Promise<void> {
      return new Promise(resolve => server.close(() => resolve()));
    }
  };
}

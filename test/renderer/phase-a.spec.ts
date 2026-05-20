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

  async function loadFixture(
    page: Page,
    options: { format?: 'urdf' | 'xacro'; omitLine?: boolean } = {}
  ): Promise<void> {
    await page.goto(`${server.url}/test/renderer/harness.html`);
    await page.waitForFunction(
      () => Array.isArray((window as any).__messages)
        && (window as any).__messages.some((message: any) => message.type === 'ready')
    );

    await page.evaluate(({ format, omitLine }) => {
      const urdf = `<?xml version="1.0"?>
<robot name="bot">
  <link name="base">
    <visual><geometry><box size="0.5 0.5 0.5"/></geometry></visual>
    <inertial><mass value="1.0"/><inertia ixx="0.01" ixy="0" ixz="0" iyy="0.02" iyz="0" izz="0.03"/></inertial>
  </link>
  <link name="tip">
    <visual><origin xyz="0.4 0 0"/><geometry><box size="0.2 0.2 0.2"/></geometry></visual>
  </link>
  <joint name="hinge" type="revolute">
    <parent link="base"/><child link="tip"/><axis xyz="0 0 1"/>
    <limit lower="-1" upper="1" effort="1" velocity="1"/>
  </joint>
</robot>`;
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'loadRobot',
          fileName: format === 'xacro' ? 'bot.xacro' : 'bot.urdf',
          sourcePath: '/tmp/bot.urdf',
          sourceBaseUri: '',
          format,
          urdf,
          packageMap: {},
          metadata: {
            robotName: 'bot',
            counts: { links: 2, joints: 1, movableJoints: 1, visualMeshes: 0, collisionMeshes: 0 },
            links: {
              base: {
                name: 'base', childJoints: ['hinge'], line: omitLine ? undefined : 3,
                inertial: { mass: 1.0, origin: [0, 0, 0], rotation: [0, 0, 0], ixx: 0.01, ixy: 0, ixz: 0, iyy: 0.02, iyz: 0, izz: 0.03 }
              },
              tip: { name: 'tip', parentJoint: 'hinge', childJoints: [], line: omitLine ? undefined : 7 }
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
    }, { format: options.format ?? 'urdf', omitLine: !!options.omitLine });
    await expect(page.locator('[data-joint-slider="hinge"]')).toBeVisible();
    await page.waitForFunction(() => Boolean((window as any).__urdfStudio));
  }

  // ---------------------------------------------------------------------------
  // Source tab
  // ---------------------------------------------------------------------------

  test('Source tab renders the URDF with line numbers and highlights selected link', async ({ page }) => {
    await loadFixture(page);
    await page.locator('.tab[data-tab="source"]').click();
    await expect(page.locator('#panel-source .source-view')).toBeVisible();
    const lineCount = await page.locator('#panel-source .source-line').count();
    expect(lineCount).toBeGreaterThan(5);

    await page.locator('.tab[data-tab="links"]').click();
    await page.locator('button[data-link="tip"]').click();
    await page.locator('.tab[data-tab="source"]').click();
    await expect(page.locator('#panel-source .source-line.active[data-source-line="7"]')).toHaveCount(1);
  });

  test('xacro format does NOT emit requestRevealRange (line map is for expanded text)', async ({ page }) => {
    await loadFixture(page, { format: 'xacro' });
    await page.evaluate(() => { (window as any).__messages.length = 0; });
    await page.locator('.tab[data-tab="links"]').click();
    await page.locator('button[data-link="tip"]').click();
    const reveals = await page.evaluate(() => {
      const messages = (window as any).__messages as Array<any>;
      return messages.filter(m => m.type === 'requestRevealRange');
    });
    expect(reveals).toEqual([]);
  });

  test('URDF format emits requestRevealRange with the link source line', async ({ page }) => {
    await loadFixture(page, { format: 'urdf' });
    await page.evaluate(() => { (window as any).__messages.length = 0; });
    await page.locator('.tab[data-tab="links"]').click();
    await page.locator('button[data-link="tip"]').click();
    const reveals = await page.evaluate(() => {
      const messages = (window as any).__messages as Array<any>;
      return messages.filter(m => m.type === 'requestRevealRange');
    });
    expect(reveals).toHaveLength(1);
    expect(reveals[0].line).toBe(7);
    expect(reveals[0].link).toBe('tip');
  });

  test('Link without a source line is selectable but produces no highlight or reveal', async ({ page }) => {
    await loadFixture(page, { omitLine: true });
    await page.evaluate(() => { (window as any).__messages.length = 0; });
    await page.locator('.tab[data-tab="links"]').click();
    await page.locator('button[data-link="tip"]').click();

    const reveals = await page.evaluate(() => {
      const messages = (window as any).__messages as Array<any>;
      return messages.filter(m => m.type === 'requestRevealRange');
    });
    expect(reveals).toEqual([]);

    await page.locator('.tab[data-tab="source"]').click();
    await expect(page.locator('#panel-source .source-line.active')).toHaveCount(0);
  });

  // ---------------------------------------------------------------------------
  // Labels overlay
  // ---------------------------------------------------------------------------

  test('Labels mode "joints" shows only joint labels', async ({ page }) => {
    await loadFixture(page);
    await page.locator('#labels-mode').selectOption('joints');
    await page.waitForFunction(() => (window as any).__urdfStudio?.labelsMode === 'joints');
    const state = await page.evaluate(() => (window as any).__urdfStudio);
    expect(state.visibleJointLabels).toBeGreaterThan(0);
    expect(state.visibleLinkLabels).toBe(0);
  });

  test('Labels mode "links" shows only link labels', async ({ page }) => {
    await loadFixture(page);
    await page.locator('#labels-mode').selectOption('links');
    await page.waitForFunction(() => (window as any).__urdfStudio?.labelsMode === 'links');
    const state = await page.evaluate(() => (window as any).__urdfStudio);
    expect(state.visibleLinkLabels).toBeGreaterThan(0);
    expect(state.visibleJointLabels).toBe(0);
  });

  test('Labels mode "off" hides everything; "both" shows everything', async ({ page }) => {
    await loadFixture(page);
    await page.locator('#labels-mode').selectOption('both');
    await page.waitForFunction(() => (window as any).__urdfStudio?.labelsMode === 'both');
    let state = await page.evaluate(() => (window as any).__urdfStudio);
    expect(state.visibleJointLabels).toBeGreaterThan(0);
    expect(state.visibleLinkLabels).toBeGreaterThan(0);

    await page.locator('#labels-mode').selectOption('off');
    await page.waitForFunction(() => (window as any).__urdfStudio?.labelsMode === 'off');
    state = await page.evaluate(() => (window as any).__urdfStudio);
    expect(state.visibleJointLabels).toBe(0);
    expect(state.visibleLinkLabels).toBe(0);
  });

  test('Reloading a robot rebuilds labels without leaking previous entries', async ({ page }) => {
    await loadFixture(page);
    await page.locator('#labels-mode').selectOption('both');
    const before = await page.evaluate(() => (window as any).__urdfStudio?.totalLabels ?? 0);
    expect(before).toBeGreaterThan(0);

    // Reload with the same fixture — labels should rebuild, not stack.
    await loadFixture(page);
    await page.locator('#labels-mode').selectOption('both');
    const after = await page.evaluate(() => (window as any).__urdfStudio?.totalLabels ?? 0);
    expect(after).toBe(before);
  });

  // ---------------------------------------------------------------------------
  // Measurement tool
  // ---------------------------------------------------------------------------

  test('Two clicks on the canvas in measure mode produce a line, markers and a distance readout', async ({ page }) => {
    await loadFixture(page);
    await page.locator('.tab[data-tab="tools"]').click();
    await page.locator('#measure-toggle').click();
    await page.waitForFunction(() => (window as any).__urdfStudio?.measureMode === true);

    const canvas = page.locator('canvas#viewport');
    const box = await canvas.boundingBox();
    expect(box).not.toBeNull();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;

    // Two clicks at slightly different positions, both within the robot
    // projection so the raycaster hits geometry.
    await page.mouse.click(cx - 20, cy);
    await page.waitForFunction(() => (window as any).__urdfStudio?.measurePointCount === 1);
    await page.mouse.click(cx + 20, cy);
    await page.waitForFunction(() => (window as any).__urdfStudio?.measurePointCount === 2);

    const state = await page.evaluate(() => (window as any).__urdfStudio);
    expect(state.measurePointCount).toBe(2);
    expect(state.measureMode).toBe(false); // auto-exits after two points
    expect(state.measureDistance).toBeGreaterThan(0);

    await expect(page.locator('#measure-readout')).toContainText(/Distance/i);
    await expect(page.locator('#measure-readout')).toContainText(/Δx/i);
  });

  test('In measure mode the Inspector does NOT switch on click (selection is suppressed)', async ({ page }) => {
    await loadFixture(page);
    await page.locator('.tab[data-tab="joints"]').click();
    await page.locator('.tab[data-tab="tools"]').click();
    await page.locator('#measure-toggle').click();

    const canvas = page.locator('canvas#viewport');
    const box = await canvas.boundingBox();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;
    await page.mouse.click(cx, cy);
    await page.waitForFunction(() => (window as any).__urdfStudio?.measurePointCount === 1);

    // No selectionChanged message should have fired: select would also flip
    // the active tab to Inspector. Tools must stay active.
    const selections = await page.evaluate(() => {
      const messages = (window as any).__messages as Array<any>;
      return messages.filter(m => m.type === 'selectionChanged');
    });
    expect(selections).toEqual([]);
    await expect(page.locator('.tab[data-tab="tools"]')).toHaveClass(/active/);
  });

  test('Clear button wipes markers, line and point count', async ({ page }) => {
    await loadFixture(page);
    await page.locator('.tab[data-tab="tools"]').click();
    await page.locator('#measure-toggle').click();

    const canvas = page.locator('canvas#viewport');
    const box = await canvas.boundingBox();
    const cx = box!.x + box!.width / 2;
    const cy = box!.y + box!.height / 2;
    await page.mouse.click(cx - 20, cy);
    await page.mouse.click(cx + 20, cy);
    await page.waitForFunction(() => (window as any).__urdfStudio?.measurePointCount === 2);

    await page.locator('#measure-clear').click();
    await page.waitForFunction(() => (window as any).__urdfStudio?.measurePointCount === 0);
    const state = await page.evaluate(() => (window as any).__urdfStudio);
    expect(state.measureDistance).toBeNull();
    expect(state.measureMode).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // BOM export
  // ---------------------------------------------------------------------------

  test('Tools tab exposes Measure and Export controls', async ({ page }) => {
    await loadFixture(page);
    await page.locator('.tab[data-tab="tools"]').click();
    await expect(page.locator('#measure-toggle')).toBeVisible();
    await expect(page.locator('#measure-clear')).toBeVisible();
    await expect(page.locator('#export-bom')).toBeVisible();
    await expect(page.locator('#export-report')).toBeVisible();
  });

  test('Export BOM posts a requestSaveBom message with valid CSV body', async ({ page }) => {
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
    expect(message.filename).toBe('bot-bom.csv');
  });

  // ---------------------------------------------------------------------------
  // PDF report — exercises the dynamic import('jspdf') path end-to-end
  // ---------------------------------------------------------------------------

  test('Export Report dynamically loads jspdf and posts a valid PDF blob', async ({ page }) => {
    await loadFixture(page);
    await page.locator('.tab[data-tab="tools"]').click();
    await page.locator('#export-report').click();

    // Wait for the async PDF build to complete and the message to arrive.
    await page.waitForFunction(() => {
      const messages = (window as any).__messages as Array<any>;
      return messages.some(m => m.type === 'requestSaveReport');
    }, { timeout: 15_000 });

    const message = await page.evaluate(() => {
      const messages = (window as any).__messages as Array<any>;
      return messages.find(m => m.type === 'requestSaveReport');
    });
    expect(message).toBeTruthy();
    expect(typeof message.base64).toBe('string');
    expect(message.base64.length).toBeGreaterThan(2000);
    // PDF magic bytes "%PDF-" → base64 "JVBERi0".
    expect(message.base64.startsWith('JVBERi0')).toBe(true);
    expect(message.filename).toBe('bot-report.pdf');

    // Verify the export status surfaces success in the UI.
    await expect(page.locator('#export-status')).toContainText(/PDF ready/i);
  });

  test('Export Report is a no-op when no robot is loaded (no crash, no message)', async ({ page }) => {
    await page.goto(`${server.url}/test/renderer/harness.html`);
    await page.waitForFunction(
      () => Array.isArray((window as any).__messages)
        && (window as any).__messages.some((message: any) => message.type === 'ready')
    );
    // Navigate to Tools tab and click export with no robot loaded. The Tools
    // panel is only built on robot load, so the buttons should be absent.
    const exportButton = page.locator('#export-report');
    expect(await exportButton.count()).toBe(0);
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

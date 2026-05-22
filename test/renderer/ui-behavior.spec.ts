import { expect, test } from '@playwright/test';
import { createReadStream, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';

// Use a viewport narrow enough that the toolbar would otherwise clip the
// "Save Pose" button on the right.
test.use({ viewport: { width: 900, height: 700 } });

test.describe('renderer UI behaviors', () => {
  let server: { url: string; close(): Promise<void> };

  test.beforeAll(async () => {
    server = await startStaticServer(path.resolve(__dirname, '..', '..'));
  });

  test.afterAll(async () => {
    await server.close();
  });

  async function loadFixture(page: import('@playwright/test').Page, jointCount = 80): Promise<void> {
    await page.goto(`${server.url}/test/renderer/harness.html`);
    await page.waitForFunction(
      () => Array.isArray((window as any).__messages)
        && (window as any).__messages.some((message: any) => message.type === 'ready')
    );

    await page.evaluate((count: number) => {
      const links: Record<string, unknown> = { base: { name: 'base', childJoints: [] as string[] } };
      const joints: Record<string, unknown> = {};
      const movableJointNames: string[] = [];
      let urdfBody = `
        <link name="base">
          <visual><geometry><box size="0.5 0.2 0.2"/></geometry></visual>
        </link>`;
      let parent = 'base';
      for (let i = 0; i < count; i += 1) {
        const linkName = `link_${i}`;
        const jointName = `joint_${i}`;
        urdfBody += `
          <link name="${linkName}">
            <visual><origin xyz="0.1 0 0"/><geometry><box size="0.1 0.1 0.1"/></geometry></visual>
          </link>
          <joint name="${jointName}" type="revolute">
            <parent link="${parent}"/><child link="${linkName}"/><axis xyz="0 0 1"/>
            <limit lower="-1" upper="1" effort="1" velocity="1"/>
          </joint>`;
        (links[parent] as any).childJoints.push(jointName);
        links[linkName] = { name: linkName, parentJoint: jointName, childJoints: [] };
        joints[jointName] = {
          name: jointName, type: 'revolute', parent, child: linkName,
          axis: [0, 0, 1], limit: { lower: -1, upper: 1 }
        };
        movableJointNames.push(jointName);
        parent = linkName;
      }
      const urdf = `<?xml version="1.0"?><robot name="fixture">${urdfBody}</robot>`;
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'loadRobot',
          fileName: 'fixture.urdf',
          sourcePath: 'fixture.urdf',
          sourceBaseUri: '',
          format: 'urdf',
          urdf,
          packageMap: {},
          metadata: {
            robotName: 'fixture',
            counts: { links: count + 1, joints: count, movableJoints: count, visualMeshes: 0, collisionMeshes: 0 },
            links,
            joints,
            meshes: [],
            rootLinks: ['base'],
            movableJointNames,
            tree: [{ link: 'base', children: [] }],
            diagnostics: []
          },
          semantic: { groups: [], states: [], diagnostics: [] },
          diagnostics: [],
          xacroArgs: [],
          xacroArgValues: {},
          renderSettings: { renderMode: 'visual', upAxis: '+Z' }
        }
      }));
    }, jointCount);

    // Wait for the joint UI to be rendered (proves loadRobot completed).
    await expect(page.locator('[data-joint-slider="joint_0"]')).toBeVisible();
  }

  test('Save Pose button stays inside the toolbar at narrow widths', async ({ page }) => {
    await loadFixture(page, 4);

    const toolbarBox = await page.locator('.toolbar').boundingBox();
    const saveBox = await page.locator('#save-pose').boundingBox();
    expect(toolbarBox).not.toBeNull();
    expect(saveBox).not.toBeNull();
    // The Save Pose button must be fully inside the toolbar's right edge.
    expect(saveBox!.x + saveBox!.width).toBeLessThanOrEqual(toolbarBox!.x + toolbarBox!.width + 0.5);
    expect(saveBox!.x).toBeGreaterThanOrEqual(toolbarBox!.x - 0.5);
  });

  test('wheel over the canvas zooms the camera and does not scroll the page', async ({ page }) => {
    await loadFixture(page, 4);

    // Capture the camera distance from the controls target via OrbitControls
    // by reading the canvas-rendered pixels before/after a wheel event.
    const canvas = page.locator('#viewport');
    const box = await canvas.boundingBox();
    if (!box) throw new Error('canvas not visible');

    // Move mouse over canvas center.
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

    const scrollBefore = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
    const before = await canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL('image/png'));

    // Dispatch several wheel events.
    for (let i = 0; i < 6; i += 1) {
      await page.mouse.wheel(0, 120);
    }
    // Allow OrbitControls damping + rAF to settle.
    await page.waitForTimeout(400);

    const scrollAfter = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
    const after = await canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL('image/png'));

    expect(scrollAfter.y).toBe(scrollBefore.y);
    expect(scrollAfter.x).toBe(scrollBefore.x);
    expect(after).not.toBe(before);
  });

  test('wheel over the HUD overlay still zooms (does not scroll)', async ({ page }) => {
    await loadFixture(page, 4);

    const hud = page.locator('#hud');
    await expect(hud).toBeVisible();
    const box = await hud.boundingBox();
    if (!box) throw new Error('hud not visible');

    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    const canvas = page.locator('#viewport');
    const before = await canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL('image/png'));
    const scrollBefore = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));

    for (let i = 0; i < 6; i += 1) {
      await page.mouse.wheel(0, 120);
    }
    await page.waitForTimeout(400);

    const after = await canvas.evaluate((node: HTMLCanvasElement) => node.toDataURL('image/png'));
    const scrollAfter = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));

    expect(scrollAfter).toEqual(scrollBefore);
    expect(after).not.toBe(before);
  });

  test('switching tabs does not change canvas size (model proportions stable)', async ({ page }) => {
    // Many joints so the Joints panel definitely needs scrolling.
    await loadFixture(page, 80);

    const canvas = page.locator('#viewport');
    const sizeOn = async () => canvas.evaluate((node: HTMLCanvasElement) => ({
      width: node.clientWidth,
      height: node.clientHeight,
      bufferWidth: node.width,
      bufferHeight: node.height
    }));

    await page.locator('.tab[data-tab="joints"]').click();
    await page.waitForTimeout(150);
    const jointsSize = await sizeOn();

    await page.locator('.tab[data-tab="inspector"]').click();
    await page.waitForTimeout(150);
    const inspectorSize = await sizeOn();

    await page.locator('.tab[data-tab="links"]').click();
    await page.waitForTimeout(150);
    const linksSize = await sizeOn();

    await page.locator('.tab[data-tab="checks"]').click();
    await page.waitForTimeout(150);
    const checksSize = await sizeOn();

    // CSS size of the canvas (i.e. the viewport area) must be identical
    // across every tab; otherwise the model visibly rescales when you switch.
    expect(inspectorSize.width).toBe(jointsSize.width);
    expect(inspectorSize.height).toBe(jointsSize.height);
    expect(linksSize.width).toBe(jointsSize.width);
    expect(linksSize.height).toBe(jointsSize.height);
    expect(checksSize.width).toBe(jointsSize.width);
    expect(checksSize.height).toBe(jointsSize.height);
  });
});

async function startStaticServer(root: string): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    const filePath = path.resolve(root, `.${decodeURIComponent(requestUrl.pathname)}`);
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
  if (filePath.endsWith('.js')) return 'text/javascript';
  if (filePath.endsWith('.css')) return 'text/css';
  return 'text/html';
}

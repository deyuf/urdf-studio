import { expect, test, type Page } from '@playwright/test';
import { createReadStream, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';

test.describe('renderer feature integrations', () => {
  let server: { url: string; close(): Promise<void> };

  test.beforeAll(async () => {
    server = await startStaticServer(path.resolve(__dirname, '..', '..'));
  });

  test('palette switch restores VS Code host colors and saves webview state', async ({ page }) => {
    await page.goto(`${server.url}/test/renderer/harness.html`);
    await page.locator('#preview-settings-menu summary').click();
    await page.waitForSelector('#palette-toggle');
    await page.evaluate(() => {
      document.body.className = 'vscode-dark';
      document.body.style.setProperty('--vscode-editor-background', '#123456');
      const api = (window as any).acquireVsCodeApi() as { getState(): unknown; setState(state: unknown): void };
      (window as any).__paletteState = { existing: 'preserved' };
      api.getState = () => (window as any).__paletteState;
      api.setState = state => { (window as any).__paletteState = state; };
    });
    const color = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    await expect.poll(color).toBe('rgb(23, 28, 27)');
    await page.getByRole('button', { name: 'Classic colors', exact: true }).click();
    await expect.poll(color).toBe('rgb(18, 52, 86)');
    expect(await page.evaluate(() => (window as any).__paletteState)).toEqual({ existing: 'preserved', palette: 'classic' });
    await page.getByRole('button', { name: 'Classic colors', exact: true }).click();
    await expect.poll(color).toBe('rgb(23, 28, 27)');
  });

  test('inspector resize supports keys, dragging, and reload persistence', async ({ page }) => {
    await loadGripperFixture(page);
    const side = page.locator('.side');
    const separator = page.getByRole('separator', { name: 'Resize inspector' });
    const initial = (await side.boundingBox())!.width;
    const canvasWidth = (await page.locator('#viewport').boundingBox())!.width;
    await separator.focus();
    await page.keyboard.press('ArrowLeft');
    await expect.poll(async () => (await side.boundingBox())!.width).toBeCloseTo(initial + 24, 0);
    await expect.poll(async () => (await page.locator('#viewport').boundingBox())!.width).toBeCloseTo(canvasWidth - 24, 0);
    const handle = (await separator.boundingBox())!;
    await page.mouse.move(handle.x + handle.width - 2, handle.y + 120);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width - 62, handle.y + 120, { steps: 8 });
    await page.mouse.up();
    await expect.poll(async () => (await side.boundingBox())!.width).toBeCloseTo(initial + 84, 0);
    await page.reload();
    await expect.poll(async () => (await side.boundingBox())!.width).toBeCloseTo(initial + 84, 0);
    await expect(separator).toHaveAttribute('aria-valuenow', String(Math.round(initial + 84)));
  });

  test('Export menu is keyboard reachable, exports pose, and restores focus', async ({ page }) => {
    await loadGripperFixture(page);
    const summary = page.locator('#export-menu summary');
    await summary.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Joint pose · JSON' })).toBeVisible();
    await page.getByRole('button', { name: 'Joint pose · JSON' }).click();
    const result = await page.evaluate(() => (window as any).__messages.find((message: any) => message.type === 'exportPoseResult'));
    expect(result.pose).toMatchObject({ left_finger: expect.any(Number) });
    expect(result.camera.position).toHaveLength(3);
    await expect(summary).toBeFocused();
    await expect(page.locator('#export-menu')).not.toHaveAttribute('open', '');
    await summary.click();
    await page.keyboard.press('Escape');
    await expect(summary).toBeFocused();
    await expect(page.locator('#export-menu')).not.toHaveAttribute('open', '');
  });

  test('Checks groups can be collapsed and expanded from the keyboard', async ({ page }) => {
    await loadGripperFixture(page);
    await page.locator('.tab[data-tab="checks"]').click();
    const group = page.locator('details.checks-group').first();
    await expect(group.locator('.checks-group-item').first()).toBeVisible();
    await group.locator('summary').focus();
    await page.keyboard.press('Enter');
    await expect(group.locator('.checks-group-item').first()).toBeHidden();
    await page.keyboard.press('Enter');
    await expect(group.locator('.check-message').first()).toBeVisible();
  });

  test.afterAll(async () => {
    await server.close();
  });

  async function loadGripperFixture(page: Page, options: { bookmarks?: Array<{ name: string; pose: Record<string, number> }> } = {}): Promise<void> {
    await page.goto(`${server.url}/test/renderer/harness.html`);
    await page.waitForFunction(
      () => Array.isArray((window as any).__messages)
        && (window as any).__messages.some((message: any) => message.type === 'ready')
    );

    await page.evaluate((bookmarks) => {
      const urdf = `<?xml version="1.0"?>
      <robot name="gripper">
        <link name="base">
          <visual><geometry><box size="0.2 0.2 0.2"/></geometry></visual>
          <inertial>
            <origin xyz="0 0 0.05" rpy="0 0 0"/>
            <mass value="1.0"/>
            <inertia ixx="0.01" ixy="0" ixz="0" iyy="0.02" iyz="0" izz="0.03"/>
          </inertial>
        </link>
        <link name="left">
          <visual><origin xyz="0.1 0 0"/><geometry><box size="0.05 0.05 0.05"/></geometry></visual>
          <inertial>
            <origin xyz="0 0 0" rpy="0 0 0"/>
            <mass value="0.1"/>
            <inertia ixx="0.001" ixy="0" ixz="0" iyy="0.001" iyz="0" izz="0.001"/>
          </inertial>
        </link>
        <link name="right">
          <visual><origin xyz="-0.1 0 0"/><geometry><box size="0.05 0.05 0.05"/></geometry></visual>
        </link>
        <joint name="left_finger" type="prismatic">
          <parent link="base"/><child link="left"/><axis xyz="1 0 0"/>
          <limit lower="0" upper="0.04" effort="50" velocity="0.5"/>
        </joint>
        <joint name="right_finger" type="prismatic">
          <parent link="base"/><child link="right"/><axis xyz="1 0 0"/>
          <mimic joint="left_finger" multiplier="-1" offset="0.1"/>
        </joint>
      </robot>`;
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'loadRobot',
          fileName: 'gripper.urdf',
          sourcePath: 'gripper.urdf',
          sourceBaseUri: '',
          format: 'urdf',
          urdf,
          packageMap: {},
          metadata: {
            robotName: 'gripper',
            counts: { links: 3, joints: 2, movableJoints: 1, visualMeshes: 0, collisionMeshes: 0 },
            links: {
              base: {
                name: 'base', childJoints: ['left_finger', 'right_finger'],
                inertial: { mass: 1.0, origin: [0, 0, 0.05], rotation: [0, 0, 0], ixx: 0.01, ixy: 0, ixz: 0, iyy: 0.02, iyz: 0, izz: 0.03 }
              },
              left: {
                name: 'left', parentJoint: 'left_finger', childJoints: [],
                inertial: { mass: 0.1, origin: [0, 0, 0], rotation: [0, 0, 0], ixx: 0.001, ixy: 0, ixz: 0, iyy: 0.001, iyz: 0, izz: 0.001 }
              },
              right: { name: 'right', parentJoint: 'right_finger', childJoints: [] }
            },
            joints: {
              left_finger: { name: 'left_finger', type: 'prismatic', parent: 'base', child: 'left', axis: [1, 0, 0], limit: { lower: 0, upper: 0.04 } },
              right_finger: { name: 'right_finger', type: 'prismatic', parent: 'base', child: 'right', axis: [1, 0, 0], limit: {}, mimic: { joint: 'left_finger', multiplier: -1, offset: 0.1 } }
            },
            meshes: [],
            rootLinks: ['base'],
            movableJointNames: ['left_finger'],
            tree: [{ link: 'base', children: [{ link: 'left', joint: 'left_finger', children: [] }, { link: 'right', joint: 'right_finger', children: [] }] }],
            totalMass: 1.2,
            diagnostics: []
          },
          semantic: { groups: [], states: [], disableCollisions: [], diagnostics: [] },
          diagnostics: [],
          xacroArgs: [],
          xacroArgValues: {},
          renderSettings: { renderMode: 'visual', upAxis: '+Z' },
          bookmarks
        }
      }));
    }, options.bookmarks ?? []);

    await expect(page.locator('[data-joint-slider="left_finger"]')).toBeVisible();
  }

  test('joint search filters joint rows by substring', async ({ page }) => {
    await loadFixtureWithMany(page);

    // All joints visible to start.
    await expect(page.locator('[data-joint-row]')).toHaveCount(20);

    await page.locator('#joint-search').fill('arm_joint_3');
    // Only joint_3 should remain visible.
    const visibleRows = await page.locator('[data-joint-row]').evaluateAll(elements =>
      elements.filter(el => (el as HTMLElement).style.display !== 'none').length
    );
    expect(visibleRows).toBe(1);

    await page.locator('#joint-search').fill('');
    const allBack = await page.locator('[data-joint-row]').evaluateAll(elements =>
      elements.filter(el => (el as HTMLElement).style.display !== 'none').length
    );
    expect(allBack).toBe(20);
  });

  test('only-modified joint filter hides joints at value 0', async ({ page }) => {
    await loadFixtureWithMany(page);

    await page.locator('[data-joint-slider="arm_joint_5"]').fill('0.5');
    await page.locator('#joint-modified-only').check();

    const visible = await page.locator('[data-joint-row]').evaluateAll(elements =>
      elements
        .filter(el => (el as HTMLElement).style.display !== 'none')
        .map(el => (el as HTMLElement).dataset.jointRow)
    );
    expect(visible).toEqual(['arm_joint_5']);
  });

  test('mimic joint surfaces in inspector and propagates master value', async ({ page }) => {
    await loadGripperFixture(page);

    await page.locator('[data-joint-slider="left_finger"]').fill('0.02');

    // 0.02 * -1 + 0.1 = 0.08 — the URDF loader will clamp to limits, but
    // since right_finger has no <limit>, the mimic value is applied as-is.
    await expect.poll(async () =>
      await page.evaluate(() => Number((window as any).__urdfStudio?.jointAngles?.right_finger ?? 0))
    ).toBeCloseTo(0.08, 5);

    // Inspect the "right" link via the Links tab to verify mimic info renders.
    await page.locator('.tab[data-tab="links"]').click();
    await page.locator('button[data-link="right"]').click();

    await expect(page.locator('#panel-inspector')).toContainText('right_finger');
    await expect(page.locator('#panel-inspector')).toContainText('left_finger');
    await expect(page.locator('#panel-inspector')).toContainText('×');
  });

  test('inertia toggle is reflected in renderer test state', async ({ page }) => {
    await loadGripperFixture(page);

    expect(await page.evaluate(() => (window as any).__urdfStudio?.inertiaVisible)).toBe(false);
    if (await page.locator('#display-menu').getAttribute('open') === null) await page.locator('#display-menu summary').click();
    await page.locator('#inertia-toggle').check();
    expect(await page.evaluate(() => (window as any).__urdfStudio?.inertiaVisible)).toBe(true);
    if (await page.locator('#display-menu').getAttribute('open') === null) await page.locator('#display-menu summary').click();
    await page.locator('#inertia-toggle').uncheck();
    expect(await page.evaluate(() => (window as any).__urdfStudio?.inertiaVisible)).toBe(false);
  });

  test('frames mode toggles per-link AxesHelpers via test-state probe', async ({ page }) => {
    await loadGripperFixture(page);

    expect(await page.evaluate(() => (window as any).__urdfStudio?.visibleLinkAxes)).toBe(0);

    if (await page.locator('#display-menu').getAttribute('open') === null) await page.locator('#display-menu summary').click();
    await page.locator('#frames-mode').selectOption('all');
    expect(await page.evaluate(() => (window as any).__urdfStudio?.visibleLinkAxes)).toBe(3);

    if (await page.locator('#display-menu').getAttribute('open') === null) await page.locator('#display-menu summary').click();
    await page.locator('#frames-mode').selectOption('off');
    expect(await page.evaluate(() => (window as any).__urdfStudio?.visibleLinkAxes)).toBe(0);
  });

  test('Save As bookmark button posts a requestSaveBookmark message', async ({ page }) => {
    await loadGripperFixture(page);

    page.on('dialog', async dialog => {
      await dialog.accept('home');
    });

    await page.locator('#bookmark-save').click();
    await page.waitForFunction(() =>
      Array.isArray((window as any).__messages)
      && (window as any).__messages.some((m: any) => m.type === 'requestSaveBookmark')
    );
    const message = await page.evaluate(() =>
      (window as any).__messages.find((m: any) => m.type === 'requestSaveBookmark')
    );
    expect(message.name).toBe('home');
    expect(message.pose).toMatchObject({ left_finger: expect.any(Number) });
    expect(message.camera).toMatchObject({ position: expect.any(Array) });
  });

  test('bookmark dropdown applies the selected pose', async ({ page }) => {
    await loadGripperFixture(page, { bookmarks: [{ name: 'open', pose: { left_finger: 0.03 } }] });

    // Initially the slider value is 0.
    expect(await page.locator('[data-joint-number="left_finger"]').inputValue()).toBe('0.000');

    await page.locator('#bookmark-select').selectOption('open');
    // Allow setJointValue + sync to propagate.
    await page.waitForTimeout(50);
    expect(await page.locator('[data-joint-number="left_finger"]').inputValue()).toBe('0.030');
  });

  test('Display menu keeps overlays on the viewport and pose actions in the header', async ({ page }) => {
    await loadGripperFixture(page);
    // View toggles live in the subtoolbar so the main toolbar can never
    // clip them when the bookmark/save group occupies the right edge.
    await page.locator('#display-menu summary').click();
    await expect(page.locator('.viewport-tools #frames-mode')).toBeVisible();
    await expect(page.locator('.viewport-tools #inertia-toggle')).toBeAttached();
    // Self-collision live toggle has been disabled in the UI.
    await expect(page.locator('#self-collision-toggle')).toHaveCount(0);
    // Save Pose button is still on the right edge of the main toolbar.
    const toolbarBox = await page.locator('.toolbar').boundingBox();
    const saveBox = await page.locator('#save-pose').boundingBox();
    expect(toolbarBox).not.toBeNull();
    expect(saveBox).not.toBeNull();
    expect(saveBox!.x + saveBox!.width).toBeLessThanOrEqual(toolbarBox!.x + toolbarBox!.width + 0.5);
  });

  test('Tools tab exposes reachability and collision-pair controls', async ({ page }) => {
    await loadGripperFixture(page);
    await page.locator('.tab[data-tab="tools"]').click();
    await expect(page.locator('#reach-run')).toBeVisible();
    await expect(page.locator('#srdf-run')).toBeVisible();
    // Reachability tip dropdown should include all leaf links.
    const options = await page.locator('#reach-tip option').evaluateAll(items => items.map(item => (item as HTMLOptionElement).value));
    expect(options.sort()).toEqual(['left', 'right']);
  });

  test('reachability sample populates the scene with points', async ({ page }) => {
    await loadFixtureWithMany(page);
    await page.locator('.tab[data-tab="tools"]').click();
    await page.locator('#reach-tip').selectOption('arm_link_19');
    await page.locator('#reach-samples').fill('500');

    expect(await page.evaluate(() => (window as any).__urdfStudio?.reachabilityPointCount)).toBe(0);

    await page.locator('#reach-run').click();
    await expect.poll(async () =>
      await page.evaluate(() => (window as any).__urdfStudio?.reachabilityPointCount ?? 0),
      { timeout: 8000 }
    ).toBe(500);

    await page.locator('#reach-clear').click();
    expect(await page.evaluate(() => (window as any).__urdfStudio?.reachabilityPointCount)).toBe(0);
  });

  async function loadFixtureWithMany(page: Page): Promise<void> {
    await page.goto(`${server.url}/test/renderer/harness.html`);
    await page.waitForFunction(
      () => Array.isArray((window as any).__messages)
        && (window as any).__messages.some((message: any) => message.type === 'ready')
    );

    await page.evaluate(() => {
      const links: Record<string, unknown> = { base: { name: 'base', childJoints: [] as string[] } };
      const joints: Record<string, unknown> = {};
      const movableJointNames: string[] = [];
      let urdfBody = `
        <link name="base">
          <visual><geometry><box size="0.5 0.2 0.2"/></geometry></visual>
        </link>`;
      let parent = 'base';
      for (let i = 0; i < 20; i += 1) {
        const linkName = `arm_link_${i}`;
        const jointName = `arm_joint_${i}`;
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
          fileName: 'arm.urdf',
          sourcePath: 'arm.urdf',
          sourceBaseUri: '',
          format: 'urdf',
          urdf,
          packageMap: {},
          metadata: {
            robotName: 'fixture',
            counts: { links: 21, joints: 20, movableJoints: 20, visualMeshes: 0, collisionMeshes: 0 },
            links,
            joints,
            meshes: [],
            rootLinks: ['base'],
            movableJointNames,
            tree: [{ link: 'base', children: [] }],
            totalMass: 0,
            diagnostics: []
          },
          semantic: { groups: [], states: [], disableCollisions: [], diagnostics: [] },
          diagnostics: [],
          xacroArgs: [],
          xacroArgValues: {},
          renderSettings: { renderMode: 'visual', upAxis: '+Z' }
        }
      }));
    });

    await expect(page.locator('[data-joint-slider="arm_joint_0"]')).toBeVisible();
  }
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

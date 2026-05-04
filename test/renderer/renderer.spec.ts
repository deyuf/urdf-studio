import { expect, test } from '@playwright/test';
import { createReadStream, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';

test('renderer loads a robot, switches modes, and moves a joint', async ({ page }) => {
  const server = await startStaticServer(path.resolve(__dirname, '..', '..'));
  try {
    await page.goto(`${server.url}/test/renderer/harness.html`);
    await page.waitForFunction(() => Array.isArray((window as any).__messages) && (window as any).__messages.some((message: any) => message.type === 'ready'));

    await page.evaluate(() => {
      const urdf = `<?xml version="1.0"?>
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
      </robot>`;
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
            counts: { links: 2, joints: 1, movableJoints: 1, visualMeshes: 0, collisionMeshes: 0 },
            links: { base: { name: 'base', childJoints: ['joint1'] }, tip: { name: 'tip', parentJoint: 'joint1', childJoints: [] } },
            joints: { joint1: { name: 'joint1', type: 'revolute', parent: 'base', child: 'tip', axis: [0, 0, 1], limit: { lower: -1, upper: 1 } } },
            meshes: [],
            rootLinks: ['base'],
            movableJointNames: ['joint1'],
            tree: [{ link: 'base', children: [{ link: 'tip', joint: 'joint1', children: [] }] }],
            diagnostics: []
          },
          semantic: { groups: [{ name: 'arm', joints: ['joint1'] }], states: [], diagnostics: [] },
          diagnostics: [],
          xacroArgs: [],
          xacroArgValues: {},
          renderSettings: { renderMode: 'visual', upAxis: '+Z' }
        }
      }));
    });

    await expect(page.locator('[data-joint-slider="joint1"]')).toBeVisible();
    await page.locator('[data-joint-slider="joint1"]').fill('0.5');
    await page.locator('#render-mode').selectOption('both');
    await page.locator('#wireframe').check();
    const dataUrl = await page.locator('canvas').evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL('image/png'));
    expect(dataUrl.length).toBeGreaterThan(1000);
  } finally {
    await server.close();
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
  if (filePath.endsWith('.js')) {
    return 'text/javascript';
  }
  if (filePath.endsWith('.css')) {
    return 'text/css';
  }
  return 'text/html';
}

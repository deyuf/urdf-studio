import { expect, test } from '@playwright/test';
import { createReadStream, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';

// =============================================================================
// XSS regression: the renderer must not execute markup contained in
// URDF/SRDF source. URDF files come from outside the trust boundary
// (the user's workspace, a downloaded ROS package, ...), and historically
// the renderer dropped them into `innerHTML` after a hand-written
// escapeHtml(). After moving panels to the html`...` template helper, we
// guard against regression here by sending a "URDF" whose link, joint,
// mesh path, and diagnostic message all contain executable HTML payloads,
// then check that:
//   1) no <script> node ever lands in the DOM,
//   2) no inline onerror=/onload=/onclick= handler executes,
//   3) the text appears verbatim (encoded) so the user still sees it.
// =============================================================================

const SCRIPT_PAYLOAD = '<script>window.__xssExecuted = "yes";</script>';
const IMG_PAYLOAD = '<img src=x onerror="window.__xssExecuted = \'yes\'">';

test('renderer escapes URDF-supplied strings into all panels', async ({ page }) => {
  const server = await startStaticServer(path.resolve(__dirname, '..', '..'));
  page.on('pageerror', error => { throw error; });
  try {
    await page.goto(`${server.url}/test/renderer/harness.html`);
    await page.waitForFunction(() =>
      Array.isArray((window as Window & { __messages?: unknown[] }).__messages) &&
      (window as Window & { __messages?: { type?: string }[] }).__messages!.some(m => m?.type === 'ready')
    );

    await page.evaluate(({ scriptPayload, imgPayload }) => {
      const linkName = `injected_link_${scriptPayload}`;
      const jointName = `injected_joint_${imgPayload}`;
      const meshPath = `meshes/${scriptPayload}/box.stl`;
      const urdf = `<?xml version="1.0"?>
<robot name="r">
  <link name="base"><visual><geometry><box size="0.1 0.1 0.1"/></geometry></visual></link>
  <link name="${linkName}"/>
  <joint name="${jointName}" type="revolute">
    <parent link="base"/><child link="${linkName}"/><axis xyz="0 0 1"/>
    <limit lower="-1" upper="1" effort="1" velocity="1"/>
  </joint>
</robot>`;
      window.dispatchEvent(new MessageEvent('message', {
        data: {
          type: 'loadRobot',
          fileName: 'attack.urdf',
          sourcePath: 'attack.urdf',
          sourceBaseUri: '',
          format: 'urdf',
          urdf,
          packageMap: {},
          metadata: {
            robotName: 'r',
            counts: { links: 2, joints: 1, movableJoints: 1, visualMeshes: 0, collisionMeshes: 0 },
            links: {
              base: { name: 'base', childJoints: [jointName] },
              [linkName]: { name: linkName, parentJoint: jointName, childJoints: [] }
            },
            joints: {
              [jointName]: {
                name: jointName, type: 'revolute', parent: 'base', child: linkName,
                axis: [0, 0, 1], limit: { lower: -1, upper: 1 }
              }
            },
            meshes: [
              { link: linkName, kind: 'visual', filename: meshPath, exists: false }
            ],
            rootLinks: ['base'],
            movableJointNames: [jointName],
            tree: [{ link: 'base', children: [{ link: linkName, joint: jointName, children: [] }] }],
            diagnostics: [
              {
                severity: 'error',
                message: `attempted ${scriptPayload} in message`,
                code: 'xss.test',
                target: linkName
              }
            ],
            totalMass: 0
          },
          semantic: {
            groups: [{ name: 'arm', joints: [jointName] }],
            states: [
              { name: `home${scriptPayload}`, group: 'arm', joints: { [jointName]: 0 } }
            ],
            disableCollisions: [],
            diagnostics: []
          },
          diagnostics: [
            {
              severity: 'error',
              message: `attempted ${scriptPayload} in message`,
              code: 'xss.test',
              target: linkName
            }
          ],
          xacroArgs: [],
          xacroArgValues: {},
          renderSettings: { renderMode: 'visual', upAxis: '+Z' }
        }
      }));
    }, { scriptPayload: SCRIPT_PAYLOAD, imgPayload: IMG_PAYLOAD });

    // Wait for the panel sections to populate.
    await expect(page.locator('#panel-joints')).toContainText(/Links/);

    // Cycle through every tab so each renderer is exercised against the
    // hostile URDF in turn.
    for (const tab of ['joints', 'inspector', 'checks', 'links', 'source']) {
      await page.locator(`.tab[data-tab="${tab}"]`).click();
    }
    // Force the inspector to load by selecting the malicious link from the
    // Links tab.
    await page.locator('.tab[data-tab="links"]').click();
    const linkButton = page.locator('button[data-link]').first();
    if (await linkButton.count() > 0) {
      await linkButton.click();
    }

    // No <script> child should have been parsed from the payload anywhere.
    const scriptCount = await page.locator('#panel-joints script, #panel-inspector script, #panel-checks script, #panel-links script, #panel-source script').count();
    expect(scriptCount, 'no <script> tag may be parsed out of URDF-controlled text').toBe(0);

    // No inline handler fired. We didn't define window.__xssExecuted; the
    // payload would assign 'yes'. Anything else means the page didn't run
    // the injected code.
    const executed = await page.evaluate(() => (window as Window & { __xssExecuted?: string }).__xssExecuted);
    expect(executed, 'XSS payload must not execute').toBeUndefined();

    // But the literal text must still be visible so the user sees the
    // hostile input rather than silently dropping it.
    await page.locator('.tab[data-tab="checks"]').click();
    await expect(page.locator('#panel-checks')).toContainText(/attempted/);
    await expect(page.locator('#panel-checks')).toContainText('<script>'); // shown literally
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
  if (filePath.endsWith('.js')) return 'text/javascript';
  if (filePath.endsWith('.css')) return 'text/css';
  return 'text/html';
}

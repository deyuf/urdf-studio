import { expect, test, type Page } from '@playwright/test';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIST_WEB = path.join(REPO_ROOT, 'dist-web');
const FIXTURE_DIR = path.join(REPO_ROOT, 'test', 'fixtures');

// =============================================================================
// Harness tests — base styles only (media/styles.css). Cover the renderer's
// own UI rules, used by both VS Code webview and the web app shell.
// =============================================================================

test.describe('UI polish (harness)', () => {
  let server: { url: string; close(): Promise<void> };

  test.beforeAll(async () => {
    server = await startStaticServer(REPO_ROOT);
  });

  test.afterAll(async () => {
    await server.close();
  });

  async function loadGripperFixture(page: Page): Promise<void> {
    await page.goto(`${server.url}/test/renderer/harness.html`);
    await page.waitForFunction(
      () => Array.isArray((window as any).__messages)
        && (window as any).__messages.some((m: any) => m.type === 'ready')
    );
    await page.evaluate(() => {
      const urdf = `<?xml version="1.0"?>
<robot name="bot">
  <link name="base"><visual><geometry><box size="0.2 0.2 0.2"/></geometry></visual></link>
  <link name="tip"><visual><origin xyz="0.3 0 0"/><geometry><box size="0.1 0.1 0.1"/></geometry></visual></link>
  <joint name="hinge" type="revolute">
    <parent link="base"/><child link="tip"/><axis xyz="0 0 1"/>
    <limit lower="-1" upper="1" effort="1" velocity="1"/>
  </joint>
  <link name="long_attribute_link">
    <visual>
      <origin xyz="0 0 0" rpy="0 0 0"/>
      <geometry>
        <mesh filename="package://some_really_long_package_name/meshes/visual/very_long_filename_that_should_definitely_wrap.dae"/>
      </geometry>
    </visual>
  </link>
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
            counts: { links: 3, joints: 1, movableJoints: 1, visualMeshes: 0, collisionMeshes: 0 },
            links: {
              base: { name: 'base', childJoints: ['hinge'], line: 3 },
              tip: { name: 'tip', parentJoint: 'hinge', childJoints: [], line: 4 },
              long_attribute_link: { name: 'long_attribute_link', childJoints: [], line: 9 }
            },
            joints: { hinge: { name: 'hinge', type: 'revolute', parent: 'base', child: 'tip', axis: [0, 0, 1], limit: { lower: -1, upper: 1 }, line: 5 } },
            meshes: [],
            rootLinks: ['base', 'long_attribute_link'],
            movableJointNames: ['hinge'],
            tree: [{ link: 'base', children: [{ link: 'tip', joint: 'hinge', children: [] }] }, { link: 'long_attribute_link', children: [] }],
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
    await expect(page.locator('[data-joint-slider="hinge"]')).toBeVisible();
  }

  test('all six tabs share the same top row at every common viewport', async ({ page }) => {
    for (const vp of [
      { width: 1024, height: 640 },
      { width: 1280, height: 800 },
      { width: 1920, height: 1080 }
    ]) {
      await page.setViewportSize(vp);
      await loadGripperFixture(page);
      const tops = await page.locator('.tabs .tab').evaluateAll(els =>
        els.map(el => Math.round((el as HTMLElement).getBoundingClientRect().top))
      );
      expect(tops, `expected six tabs at viewport ${vp.width}×${vp.height}`).toHaveLength(6);
      const range = Math.max(...tops) - Math.min(...tops);
      expect(range, `tabs wrap at viewport ${vp.width}×${vp.height} (tops=${tops.join(',')})`).toBeLessThanOrEqual(2);
    }
  });

  test('Source pane wraps long URDF lines instead of clipping them', async ({ page }) => {
    await loadGripperFixture(page);
    await page.locator('.tab[data-tab="source"]').click();

    // The long <mesh filename="package://..."> line in the fixture is well
    // over 200 characters wide. With white-space: pre-wrap + overflow-wrap:
    // anywhere it must wrap inside the panel, not overflow horizontally.
    const measurement = await page.evaluate(() => {
      const panel = document.getElementById('panel-source') as HTMLElement;
      const lines = panel.querySelectorAll<HTMLDivElement>('.source-line');
      const longLine = Array.from(lines).find(line => (line.textContent ?? '').includes('very_long_filename_that_should_definitely_wrap'));
      if (!longLine) return null;
      const text = longLine.querySelector<HTMLElement>('.source-text')!;
      const panelStyle = getComputedStyle(panel);
      const lineHeight = parseFloat(getComputedStyle(text).lineHeight);
      return {
        textHeight: text.getBoundingClientRect().height,
        panelClientWidth: panel.clientWidth,
        panelScrollWidth: panel.scrollWidth,
        whiteSpace: getComputedStyle(text).whiteSpace,
        overflowWrap: getComputedStyle(text).overflowWrap,
        lineHeight,
        panelOverflowX: panelStyle.overflowX
      };
    });
    expect(measurement, 'expected the long-attribute line to be present').not.toBeNull();
    // Either wraps into multiple lines (height ≥ 2× line-height), or stays
    // within panel width — both prove no horizontal clipping.
    expect(
      measurement!.textHeight >= measurement!.lineHeight * 1.8
        || measurement!.panelScrollWidth <= measurement!.panelClientWidth + 1,
      `expected long line to wrap; got textHeight=${measurement!.textHeight}, lineHeight=${measurement!.lineHeight}, scrollW=${measurement!.panelScrollWidth}, clientW=${measurement!.panelClientWidth}`
    ).toBe(true);
    expect(['pre-wrap', 'break-spaces']).toContain(measurement!.whiteSpace);
  });

  test('Source pane gutter renders multi-digit line numbers without splitting them', async ({ page }) => {
    // Load a fixture with > 10 lines so we exercise multi-digit gutter
    // numbers, and a long wrapped line so the gutter sits next to wrapping
    // content. If overflow-wrap leaked into the gutter, "11" or "15" would
    // visually split into "1" / "1" on separate rows.
    await loadGripperFixture(page);
    await page.locator('.tab[data-tab="source"]').click();

    const gutterInfo = await page.evaluate(() => {
      const gutters = Array.from(document.querySelectorAll<HTMLElement>('#panel-source .source-gutter'));
      // For every multi-digit gutter, measure its rendered width vs the
      // intrinsic content width. If the digits wrapped, the rendered
      // bounding box would be taller than one line-height.
      return gutters
        .filter(g => (g.textContent ?? '').trim().length >= 2)
        .map(g => ({
          text: g.textContent?.trim() ?? '',
          height: Math.round(g.getBoundingClientRect().height),
          lineHeight: parseFloat(getComputedStyle(g).lineHeight),
          whiteSpace: getComputedStyle(g).whiteSpace
        }));
    });
    expect(gutterInfo.length).toBeGreaterThan(0);
    for (const info of gutterInfo) {
      expect(info.whiteSpace, `gutter "${info.text}" must be nowrap`).toBe('nowrap');
      // height must stay within a single line.
      expect(info.height, `gutter "${info.text}" wrapped (h=${info.height} > line=${info.lineHeight})`).toBeLessThanOrEqual(Math.ceil(info.lineHeight) + 1);
    }
  });
});

// =============================================================================
// Web shell tests — exercise the real dist-web build so the container query
// in web.css (font-size step at narrow panels) actually applies.
// =============================================================================

test.describe('UI polish (web shell)', () => {
  let server: { url: string; close(): Promise<void> };

  test.beforeAll(async () => {
    if (!existsSync(path.join(DIST_WEB, 'app.js'))) {
      throw new Error('Run `npm run web:build` before the web shell tests.');
    }
    server = await startStaticServer(DIST_WEB);
  });

  test.afterAll(async () => {
    await server.close();
  });

  test('Inspector tab is fully rendered (no ellipsis) at a typical laptop width', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'webkitdirectory only on chromium.');
    await page.setViewportSize({ width: 1366, height: 768 });
    await page.goto(server.url);
    if (await page.locator('dialog.onboarding').isVisible()) {
      await page.locator('[data-action="skip"]').click();
    }
    await page.setInputFiles('#file-input', FIXTURE_DIR);
    await expect(page.locator('#file-select')).toBeEnabled({ timeout: 10_000 });
    const targetValue = await page.locator('#file-select option').evaluateAll(options => {
      const target = options.find(option => /(^|\/)model\.xacro$/.test((option as HTMLOptionElement).value));
      return target ? (target as HTMLOptionElement).value : '';
    });
    await page.locator('#file-select').selectOption(targetValue);
    await expect(page.locator('[data-joint-slider="fixture_joint"]')).toBeVisible({ timeout: 15_000 });

    const widths = await page.locator('.tabs .tab').evaluateAll(els =>
      els.map(el => ({
        text: el.textContent?.trim() ?? '',
        client: (el as HTMLElement).clientWidth,
        scroll: (el as HTMLElement).scrollWidth
      }))
    );
    const inspector = widths.find(w => w.text === 'Inspector');
    expect(inspector, `expected Inspector tab among ${widths.map(w => w.text).join(',')}`).toBeTruthy();
    // scrollWidth > clientWidth ⇒ text is overflowing and being ellipsised.
    expect(
      inspector!.scroll,
      `Inspector ellipsised: scrollWidth=${inspector!.scroll}, clientWidth=${inspector!.client}`
    ).toBeLessThanOrEqual(inspector!.client + 1);

    // All other labels likewise.
    for (const w of widths) {
      expect(w.scroll, `tab "${w.text}" ellipsised (scroll=${w.scroll} > client=${w.client})`).toBeLessThanOrEqual(w.client + 1);
    }
  });
});

async function startStaticServer(root: string): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    let filePath = path.join(root, decodeURIComponent(url.pathname));
    if (filePath.endsWith('/')) filePath = path.join(filePath, 'index.html');
    if (!filePath.startsWith(root) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
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
  if (!address || typeof address === 'string') throw new Error('bind failed');
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>(resolve => server.close(() => resolve()))
  };
}

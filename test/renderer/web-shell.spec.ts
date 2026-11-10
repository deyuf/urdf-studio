import { startStaticServer } from './helpers';
import { expect, test, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIST_WEB = path.join(REPO_ROOT, 'dist-web');
const FIXTURE_DIR = path.join(REPO_ROOT, 'test', 'fixtures');
const LEAK_FIXTURE_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'leak_test');
const BAD_FIXTURE_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'bad_urdf');

// Files we will inject via the webkitdirectory fallback path. Browsers strip
// File System Access API from headless contexts unless granted explicit user
// gestures, so we use the FileList fallback that AppShell already supports.
// Playwright walks the FIXTURE_DIR recursively when setInputFiles() is given
// a directory path; the file layout we expose to the browser is documented
// in test/fixtures/ on disk (xacro_pkg/{package.xml,urdf/part.xacro,
// config/test.yaml} + model.xacro at the root).

/** Record every blob download (type, text, filename) on `window.__downloads`
 *  and swallow the anchor click so no real download starts. */
async function captureDownloads(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const win = window as unknown as {
      __downloads: Array<{ type: string; size: number; text: string; name?: string; url: string }>;
    };
    win.__downloads = [];
    const origCreate = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (obj: Blob | MediaSource) => {
      const url = origCreate(obj);
      if (obj instanceof Blob) {
        const entry: { type: string; size: number; text: string; name?: string; url: string } = {
          type: obj.type,
          size: obj.size,
          text: '',
          url
        };
        win.__downloads.push(entry);
        void obj.text().then(text => { entry.text = text; });
      }
      return url;
    };
    const origClick = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) {
        const entry = win.__downloads.find(d => d.url === this.href);
        if (entry) {
          entry.name = this.download;
        }
        return;
      }
      return origClick.call(this);
    };
  });
}

test.describe('web shell', () => {
  let server: { url: string; close(): Promise<void> };

  test.beforeAll(async () => {
    if (!existsSync(path.join(DIST_WEB, 'app.js'))) {
      throw new Error('Run `npm run web:build` before the web shell tests.');
    }
    server = await startStaticServer(DIST_WEB);
  });

  test.afterAll(async () => {
    // Guard against beforeAll having thrown before `server` was assigned, so
    // the real setup error surfaces instead of a TypeError from this hook.
    await server?.close();
  });

  test('loads a xacro fixture via the webkitdirectory fallback, renders, moves a joint, exports a screenshot', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Headless Firefox does not honour webkitdirectory in CI.');

    const consoleErrors: string[] = [];
    page.on('pageerror', error => consoleErrors.push(error.message));
    page.on('console', message => {
      if (message.type() !== 'error') {
        return;
      }
      const text = message.text();
      consoleErrors.push(text);
    });

    await page.goto(server.url);

    // The renderer registers a global 'ready' message we can wait on. The
    // host's queueing logic forwards loadRobot only after this.
    await expect(page.locator('#topbar')).toBeVisible();

    // Playwright supports a directory path for webkitdirectory inputs — it
    // recursively enumerates the directory and assigns webkitRelativePath.
    await page.setInputFiles('#file-input', FIXTURE_DIR);

    // After indexing, the file select should now contain at least one URDF.
    await expect(page.locator('#file-select')).toBeEnabled({ timeout: 10_000 });
    // Pick the model.xacro entry by inspecting available options.
    const targetValue = await page.locator('#file-select option').evaluateAll(options => {
      const target = options.find(option => /(^|\/)model\.xacro$/.test((option as HTMLOptionElement).value));
      return target ? (target as HTMLOptionElement).value : '';
    });
    expect(targetValue, 'model.xacro must be among the indexed files').not.toEqual('');
    await page.locator('#file-select').selectOption(targetValue);

    // Wait for the renderer to load the robot.
    await expect(page.locator('[data-joint-slider="fixture_joint"]')).toBeVisible({ timeout: 15_000 });

    // Drive a joint to a new value.
    await page.locator('[data-joint-slider="fixture_joint"]').fill('0.4');

    // Switch render modes — exercises the renderer's mode toggle.
    await page.locator('#render-mode').selectOption('both');

    // Validate canvas produces a non-empty image.
    const dataUrl = await page.locator('canvas#viewport').evaluate((canvas: HTMLCanvasElement) => canvas.toDataURL('image/png'));
    expect(dataUrl.length).toBeGreaterThan(1000);

    // The HUD or status should reflect a non-error state.
    const statusKind = await page.locator('#topbar-status').getAttribute('data-kind');
    expect(statusKind === null || statusKind === 'info' || statusKind === 'progress').toBeTruthy();

    expect(consoleErrors, `unexpected console errors:\n${consoleErrors.join('\n')}`).toEqual([]);
  });

  test('parse problems surface as a bottom-corner error toast', async ({ page }) => {
    await page.goto(server.url);
    if (await page.locator('dialog.onboarding').isVisible()) {
      await page.locator('[data-action="skip"]').click();
    }
    await page.setInputFiles('#file-input', BAD_FIXTURE_DIR);
    await expect(page.locator('#file-select')).toBeEnabled({ timeout: 10_000 });
    const target = await page.locator('#file-select option').evaluateAll(opts => {
      const found = opts.find(o => /missing_mesh\.urdf$/.test((o as HTMLOptionElement).value));
      return found ? (found as HTMLOptionElement).value : '';
    });
    expect(target).not.toEqual('');
    await page.locator('#file-select').selectOption(target);

    // The bad fixture references a mesh that doesn't exist on disk — analyzer
    // emits `mesh.missing` as an error. The host turns that into a toast.
    const toast = page.locator('#toast-container .toast-error');
    await expect(toast).toBeVisible({ timeout: 10_000 });
    await expect(toast).toContainText(/error/i);
    // The detail mentions the diagnostic kind.
    await expect(toast).toContainText(/mesh/i);

    // The toast is sticky for errors — it does not auto-dismiss.
    await page.waitForTimeout(800);
    await expect(toast).toBeVisible();

    // Closing it via the × button hides it.
    await toast.locator('.toast-close').click();
    await expect(toast).toBeHidden();
  });

  test('settings dialog: Cancel and Save both close the dialog', async ({ page }) => {
    await page.goto(server.url);
    // Dismiss the onboarding tour first if it is visible.
    if (await page.locator('dialog.onboarding').isVisible()) {
      await page.locator('[data-action="skip"]').click();
    }

    // Open settings via the gear button.
    await page.locator('#settings-btn').click();
    await page.locator('#model-settings-btn').click();
    const dialog = page.locator('dialog#settings-dialog');
    await expect(dialog).toBeVisible();

    // Cancel must close the dialog.
    await dialog.locator('button[value="cancel"]').click();
    await expect(dialog).toBeHidden();

    // Re-open, then click Save — also closes, also persists.
    await page.locator('#settings-btn').click();
    await page.locator('#model-settings-btn').click();
    await expect(dialog).toBeVisible();
    await dialog.locator('select[name="upAxis"]').selectOption('+Y');
    await dialog.locator('button[value="save"]').click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('urdf-studio:settings:v1') || '{}').upAxis)).toBe('+Y');
  });

  test('self-collision and collision pairs use link names, skip neighbours and geometry-less links', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'webkitdirectory only on chromium.');
    const errors: string[] = [];
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    await page.goto(server.url);
    if (await page.locator('dialog.onboarding').isVisible()) {
      await page.locator('[data-action="skip"]').click();
    }
    await page.setInputFiles('#file-input', path.join(FIXTURE_DIR, 'collision'));
    await expect(page.locator('[data-joint-slider="ja"]')).toBeVisible({ timeout: 15_000 });

    // Live overlay: only base↔c touch; neighbours touching at joints are ignored.
    await page.locator('#render-mode').selectOption('collision');
    await page.locator('#display-menu summary').click();
    await page.locator('#selfcollision-toggle').check();
    await page.keyboard.press('Escape');
    await expect(page.locator('#collide-hud')).toHaveText(/^Self-collision: (base ↔ c|c ↔ base)$/, { timeout: 10_000 });

    // Pair analysis covers only links that have collision geometry.
    await page.locator('.tab[data-tab="tools"]').click();
    await page.locator('#srdf-samples').fill('100');
    await page.locator('#srdf-run').click();
    await expect(page.locator('#srdf-status')).toContainText('1 link without collision geometry left out', { timeout: 30_000 });
    await expect(page.locator('#srdf-status')).toContainText('of 3 link pairs');
    await expect(page.locator('#srdf-results')).not.toContainText('imu');

    // The source highlighter handles a package:// path below the tags.
    await page.locator('.tab[data-tab="source"]').click();
    await expect(page.locator('#panel-source .cm-urdf-package')).toHaveCount(1);
    expect(errors.filter(text => /plugin crashed/.test(text))).toEqual([]);
  });

  test('opens a MuJoCo MJCF model from a folder, read-only, and saves it as URDF', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'webkitdirectory only on chromium.');
    await captureDownloads(page);
    await page.goto(server.url);
    if (await page.locator('dialog.onboarding').isVisible()) {
      await page.locator('[data-action="skip"]').click();
    }
    await page.setInputFiles('#file-input', path.join(FIXTURE_DIR, 'mjcf', 'arm'));
    await expect(page.locator('#file-select')).toBeEnabled({ timeout: 10_000 });
    // Both MuJoCo files are offered; scene.xml (the Menagerie entry point) first.
    const options = await page.locator('#file-select option').evaluateAll(o => o.map(x => (x as HTMLOptionElement).value).filter(Boolean));
    expect(options.map(value => value.split('/').pop())).toEqual(['scene.xml', 'arm.xml']);
    await page.locator('#file-select').selectOption(options[0]);

    await expect(page.locator('[data-joint-slider="shoulder_pan"]')).toBeVisible({ timeout: 15_000 });
    await expect(page.locator('[data-joint-slider="elbow"]')).toBeVisible();
    await expect(page.locator('#hud')).toContainText('2 movable joints');

    // MuJoCo infers inertia from geoms, so P-001 is not reported for MJCF.
    await page.locator('.tab[data-tab="checks"]').click();
    await expect(page.locator('#panel-checks')).not.toContainText('P-001');

    await page.locator('.tab[data-tab="source"]').click();
    await expect(page.locator('#panel-source .source-meta')).toContainText('converted from MJCF');
    await page.locator('#panel-source .source-edit-toggle').click();
    await page.locator('#panel-source .cm-content').click();
    await page.keyboard.press('Control+s');
    await page.waitForFunction(() => ((window as any).__downloads as Array<{ name?: string }>).some(d => d.name), null, { timeout: 5_000 });
    const names = await page.evaluate(() => ((window as any).__downloads as Array<{ name?: string }>).map(d => d.name).filter(Boolean));
    expect(names).toEqual(['scene.urdf']);
  });

  test('saving settings re-applies them to the open robot and keeps its pose', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'webkitdirectory only on chromium.');
    await page.goto(server.url);
    if (await page.locator('dialog.onboarding').isVisible()) {
      await page.locator('[data-action="skip"]').click();
    }
    await page.setInputFiles('#file-input', FIXTURE_DIR);
    await expect(page.locator('#file-select')).toBeEnabled({ timeout: 10_000 });
    const fixture = await page.locator('#file-select option').evaluateAll(options =>
      options.map(option => (option as HTMLOptionElement).value).find(value => /(^|\/)model\.xacro$/.test(value)) ?? ''
    );
    await page.locator('#file-select').selectOption(fixture);
    await expect(page.locator('[data-joint-slider="fixture_joint"]')).toBeVisible({ timeout: 15_000 });
    await page.locator('[data-joint-number="fixture_joint"]').fill('0.25');
    await page.locator('[data-joint-number="fixture_joint"]').press('Enter');
    await expect(page.locator('#render-mode')).toHaveValue('visual');

    await page.locator('#settings-btn').click();
    await page.locator('#model-settings-btn').click();
    const dialog = page.locator('dialog#settings-dialog');
    await dialog.locator('select[name="defaultRenderMode"]').selectOption('collision');
    await dialog.locator('button[value="save"]').click();

    await expect(page.locator('#render-mode')).toHaveValue('collision', { timeout: 15_000 });
    await expect(page.locator('[data-joint-number="fixture_joint"]')).toHaveValue('0.250');
  });

  test('theme switcher persists across reloads and flips data-theme', async ({ page }) => {
    const viewportPixel = () => page.locator('#viewport').evaluate((source: HTMLCanvasElement) => {
      const sample = document.createElement('canvas');
      sample.width = sample.height = 1;
      const context = sample.getContext('2d')!;
      context.drawImage(source, 0, 0, 1, 1, 0, 0, 1, 1);
      return Array.from(context.getImageData(0, 0, 1, 1).data).slice(0, 3);
    });
    await page.goto(server.url);
    if (await page.locator('dialog.onboarding').isVisible()) {
      await page.locator('[data-action="skip"]').click();
    }

    // A loaded model is required: the renderer deliberately leaves its
    // canvas blank until geometry is ready.
    await page.setInputFiles('#file-input', FIXTURE_DIR);
    await expect(page.locator('#file-select')).toBeEnabled();
    const fixture = await page.locator('#file-select option').evaluateAll(options =>
      options.map(option => (option as HTMLOptionElement).value).find(value => /(^|\/)model\.xacro$/.test(value)) ?? ''
    );
    await page.locator('#file-select').selectOption(fixture);
    await expect(page.locator('[data-joint-slider="fixture_joint"]')).toBeVisible();

    // System default — no data-theme override needed; light-dark() follows OS.
    const initial = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
    expect(initial).toBe('system');

    // Pick dark. startViewTransition runs its callback asynchronously,
    // so the data-theme attribute updates a frame or two after the click.
    await page.locator('.theme-switcher-btn[data-theme="dark"]').click();
    await expect(page.locator('.theme-switcher-btn[data-theme="dark"]')).toHaveAttribute('data-active', 'true');
    await expect.poll(
      () => page.evaluate(() => document.documentElement.getAttribute('data-theme'))
    ).toBe('dark');

    // The WebGL drawing surface follows the selected chrome theme too.
    await expect.poll(viewportPixel).toEqual([25, 31, 27]);

    // Choice persists via localStorage.
    expect(await page.evaluate(() => localStorage.getItem('urdf-studio:theme:v1'))).toBe('dark');

    // Reload — dark sticks.
    await page.reload();
    expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark');

    await page.setInputFiles('#file-input', FIXTURE_DIR);
    await expect(page.locator('#file-select')).toBeEnabled();
    await page.locator('#file-select').selectOption(fixture);
    await expect(page.locator('[data-joint-slider="fixture_joint"]')).toBeVisible();

    // Flip to light.
    if (await page.locator('dialog.onboarding').isVisible()) {
      await page.locator('[data-action="skip"]').click();
    }
    await page.locator('.theme-switcher-btn[data-theme="light"]').click();
    await expect.poll(
      () => page.evaluate(() => document.documentElement.getAttribute('data-theme'))
    ).toBe('light');
    await expect.poll(viewportPixel).toEqual([232, 236, 228]);

    // Palette selection is independent of light/dark mode and persists.
    await page.locator('#settings-btn').click();
    const palette = page.getByRole('button', { name: 'Classic colors', exact: true });
    await palette.click();
    await expect(palette).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(viewportPixel).toEqual([24, 24, 24]);
    expect(await page.locator('html').getAttribute('data-theme')).toBe('light');
    await page.reload();
    await page.locator('#settings-btn').click();
    await expect(palette).toHaveAttribute('aria-pressed', 'true');
    await page.setInputFiles('#file-input', FIXTURE_DIR);
    await expect(page.locator('#file-select')).toBeEnabled();
    await page.locator('#file-select').selectOption(fixture);
    await expect(page.locator('[data-joint-slider="fixture_joint"]')).toBeVisible();
    await palette.click();
    await expect(palette).toHaveAttribute('aria-pressed', 'false');
    await expect.poll(viewportPixel).toEqual([232, 236, 228]);
  });

  for (const display of [
    { name: '2K native', width: 2560, height: 1440, scale: 1 },
    { name: '2K at 150% scaling', width: 1707, height: 960, scale: 1.5 }
  ]) {
    test.describe(display.name, () => {
      test.use({ viewport: { width: display.width, height: display.height }, deviceScaleFactor: display.scale });
      test('workbench, settings, and source layouts fit the display', async ({ page }) => {
        await page.goto(server.url);
        if (await page.locator('dialog.onboarding').isVisible()) await page.locator('[data-action="skip"]').click();
        await page.setInputFiles('#file-input', FIXTURE_DIR);
        await expect(page.locator('#file-select')).toBeEnabled();
        const fixture = await page.locator('#file-select option').evaluateAll(options =>
          options.map(option => (option as HTMLOptionElement).value).find(value => /(^|\/)model\.xacro$/.test(value)) ?? ''
        );
        await page.locator('#file-select').selectOption(fixture);
        await expect(page.locator('[data-joint-slider="fixture_joint"]')).toBeVisible();
        const panel = (await page.locator('.side').boundingBox())!;
        expect(panel.width).toBeCloseTo(440, 0);
        const canvas = (await page.locator('#viewport').boundingBox())!;
        expect(canvas.x + canvas.width).toBeCloseTo(panel.x, 0);
        const footer = (await page.locator('.project-footer').boundingBox())!;
        expect(canvas.height).toBeGreaterThan(display.height - 180 - footer.height);
        expect(canvas.y + canvas.height).toBeLessThanOrEqual(footer.y + 1);
        const overflow = await page.locator('.tabs .tab, .topbar-actions > *, .toolbar-group-end > *').evaluateAll(elements =>
          elements.filter(element => element.getBoundingClientRect().width > 0).map(element => ({
            text: element.textContent?.trim(),
            client: element.clientWidth,
            scroll: element.scrollWidth,
            right: element.getBoundingClientRect().right
          }))
        );
        for (const item of overflow) {
          expect(item.scroll, `${item.text} should fit`).toBeLessThanOrEqual(item.client + 1);
          expect(item.right).toBeLessThanOrEqual(display.width);
        }
        await expect(page.locator('.toolbar #palette-toggle')).toHaveCount(0);
        await page.locator('#settings-btn').focus();
        await page.keyboard.press('Enter');
        await expect(page.locator('#settings-menu #palette-toggle')).toBeVisible();
        await page.locator('#palette-toggle').click();
        await expect(page.locator('#palette-toggle')).toHaveAttribute('aria-pressed', 'true');
        const menu = (await page.locator('.settings-options').boundingBox())!;
        expect(menu.x).toBeGreaterThanOrEqual(0);
        expect(menu.x + menu.width).toBeLessThanOrEqual(display.width);
        await page.keyboard.press('Escape');
        await expect(page.locator('#settings-menu')).not.toHaveAttribute('open', '');
        await expect(page.locator('#settings-btn')).toBeFocused();
        await page.locator('.tab[data-tab="source"]').click();
        await expect(page.locator('#panel-source .cm-editor')).toBeVisible();
        await page.evaluate(() => document.querySelector('#panel-source')!.dispatchEvent(
          new CustomEvent('urdf-studio:request-fullscreen-toggle', { bubbles: true })
        ));
        await expect(page.locator('#workspace')).toHaveClass(/layout-source-fullscreen/);
        expect((await page.locator('.side').boundingBox())!.width).toBeCloseTo(display.width, 0);
        await page.evaluate(() => document.querySelector('#panel-source')!.dispatchEvent(
          new CustomEvent('urdf-studio:request-fullscreen-toggle', { bubbles: true })
        ));
        await expect(page.locator('#workspace')).not.toHaveClass(/layout-source-fullscreen/);
        expect((await page.locator('.side').boundingBox())!.width).toBeCloseTo(panel.width, 0);
        expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(display.width);
      });
    });
  }

  test('shows a helpful empty state before any folder is loaded', async ({ page }) => {
    await page.goto(server.url);
    await expect(page.locator('#file-select')).toBeDisabled();
    await expect(page.locator('canvas#viewport')).toBeVisible();
    await expect(page.locator('#hud')).toContainText(/Waiting for robot/i);
  });

  test('onboarding tour appears on first visit, advances, and stays dismissed', async ({ page, context }) => {
    // Fresh context — no localStorage carry-over from previous tests.
    await context.clearCookies();
    await page.goto(server.url);

    const dialog = page.locator('dialog.onboarding');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('h2')).toContainText('Welcome');

    // Advance through every step.
    for (let i = 0; i < 3; i++) {
      await dialog.locator('[data-action="next"]').click();
      await expect(dialog.locator('.onboarding-step')).toContainText(`Step ${i + 2} of`);
    }

    // Final step → Get started closes the dialog.
    await dialog.locator('[data-action="next"]').click();
    await expect(dialog).toBeHidden();

    // Reloading the page should NOT re-show it — the seen flag is persisted.
    await page.reload();
    await expect(page.locator('#topbar')).toBeVisible();
    await expect(dialog).toBeHidden();

    // The help button re-opens it.
    await page.locator('#help-btn').click();
    await expect(dialog).toBeVisible();
  });

  test('reloading the same model does not leak blob URLs', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Headless Firefox does not honour webkitdirectory in CI.');

    // Instrument URL.createObjectURL / revokeObjectURL before app.js runs so
    // we can count net live blob URLs across multiple loads. The two-generation
    // strategy guarantees the live count returns to (current URLs only) after
    // each load completes.
    await page.addInitScript(() => {
      const created = new Set<string>();
      const win = window as unknown as {
        __blobTracker: { live(): number; created: number; revoked: number };
      };
      const origCreate = URL.createObjectURL.bind(URL);
      const origRevoke = URL.revokeObjectURL.bind(URL);
      let createdCount = 0;
      let revokedCount = 0;
      URL.createObjectURL = (obj: Blob | MediaSource) => {
        const url = origCreate(obj);
        created.add(url);
        createdCount++;
        return url;
      };
      URL.revokeObjectURL = (url: string) => {
        if (created.delete(url)) {
          revokedCount++;
        }
        origRevoke(url);
      };
      win.__blobTracker = {
        live: () => created.size,
        get created() { return createdCount; },
        get revoked() { return revokedCount; }
      };
    });

    await page.goto(server.url);
    await page.setInputFiles('#file-input', LEAK_FIXTURE_DIR);
    await expect(page.locator('#file-select')).toBeEnabled({ timeout: 10_000 });
    const targetValue = await page.locator('#file-select option').evaluateAll(options => {
      const target = options.find(option => /(^|\/)robot\.urdf$/.test((option as HTMLOptionElement).value));
      return target ? (target as HTMLOptionElement).value : '';
    });
    expect(targetValue).not.toEqual('');

    const altTargetValue = await page.locator('#file-select option').evaluateAll(options => {
      const target = options.find(option => /(^|\/)robot_alt\.urdf$/.test((option as HTMLOptionElement).value));
      return target ? (target as HTMLOptionElement).value : '';
    });
    expect(altTargetValue).not.toEqual('');

    // First load — should mint a blob URL for box.stl.
    await page.locator('#file-select').selectOption(targetValue);
    await expect(page.locator('[data-joint-slider="hinge"]')).toBeVisible({ timeout: 15_000 });
    await expect.poll(() => page.evaluate(() => (window as any).__blobTracker.created)).toBeGreaterThanOrEqual(1);
    const afterFirst = await page.evaluate(() => (window as unknown as { __blobTracker: { live(): number } }).__blobTracker.live());

    // Alternate between two URDFs four times. Each switch generates one fresh
    // URL and revokes the previous-generation one. Live count must stay bounded
    // (1 mesh per load), not grow linearly.
    for (let i = 0; i < 4; i++) {
      const next = i % 2 === 0 ? altTargetValue : targetValue;
      const createdBefore = await page.evaluate(() => (window as any).__blobTracker.created);
      const revokedBefore = await page.evaluate(() => (window as any).__blobTracker.revoked);
      await page.locator('#file-select').selectOption('');
      await page.locator('#file-select').selectOption(next);
      await expect(page.locator('[data-joint-slider="hinge"]')).toBeVisible({ timeout: 15_000 });
      await expect.poll(() => page.evaluate(() => (window as any).__blobTracker.created)).toBeGreaterThan(createdBefore);
      await expect.poll(() => page.evaluate(() => (window as any).__blobTracker.revoked)).toBeGreaterThan(revokedBefore);
    }
    const afterMany = await page.evaluate(() => {
      const tracker = (window as unknown as { __blobTracker: { live(): number; created: number; revoked: number } }).__blobTracker;
      return { live: tracker.live(), created: tracker.created, revoked: tracker.revoked };
    });

    // Five loads, never more than one mesh URL alive at a time — the live
    // count must not have grown by more than ~1 from the baseline single load.
    expect(afterMany.live - afterFirst).toBeLessThanOrEqual(1);
    // Revocations must have happened — proves the generation logic is wired.
    expect(afterMany.revoked).toBeGreaterThanOrEqual(2);
    // And many more URLs were created than are alive — proves we are not just
    // never allocating in the first place.
    expect(afterMany.created).toBeGreaterThan(afterMany.live);
  });

  test('Export BOM drives the browser host download path (captures a real CSV blob)', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Headless Firefox does not honour webkitdirectory in CI.');

    await captureDownloads(page);

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

    // Switch to Tools tab and click Export BOM.
    await page.locator('.tab[data-tab="tools"]').click();
    await page.locator('#export-bom').click();

    // Wait until the host has produced a CSV-typed blob with text + filename.
    await page.waitForFunction(() => {
      const downloads = (window as any).__downloads as Array<{ type: string; text: string; name?: string }>;
      return downloads.some(d => d.type === 'text/csv' && d.text.length > 0 && d.name);
    }, { timeout: 5_000 });

    const csvDownload = await page.evaluate(() => {
      const downloads = (window as any).__downloads as Array<{ type: string; size: number; text: string; name?: string }>;
      return downloads.find(d => d.type === 'text/csv');
    });
    expect(csvDownload).toBeTruthy();
    expect(csvDownload!.size).toBeGreaterThan(0);
    expect(csvDownload!.text).toContain('link,parent_joint');
    expect(csvDownload!.name).toMatch(/\.csv$/);
  });

  test('saving an edited xacro downloads expanded URDF under a .urdf name', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'webkitdirectory only on chromium.');
    await captureDownloads(page);
    await page.goto(server.url);
    if (await page.locator('dialog.onboarding').isVisible()) {
      await page.locator('[data-action="skip"]').click();
    }
    await page.setInputFiles('#file-input', FIXTURE_DIR);
    await expect(page.locator('#file-select')).toBeEnabled({ timeout: 10_000 });
    const targetValue = await page.locator('#file-select option').evaluateAll(options =>
      options.map(option => (option as HTMLOptionElement).value).find(value => /(^|\/)model\.xacro$/.test(value)) ?? ''
    );
    await page.locator('#file-select').selectOption(targetValue);
    await expect(page.locator('[data-joint-slider="fixture_joint"]')).toBeVisible({ timeout: 15_000 });

    await page.locator('.tab[data-tab="source"]').click();
    await page.locator('#panel-source .source-edit-toggle').click();
    await page.locator('#panel-source .cm-content').click();
    await page.keyboard.press('Control+s');

    await page.waitForFunction(() => ((window as any).__downloads as Array<{ name?: string }>).some(d => d.name), null, { timeout: 5_000 });
    const names = await page.evaluate(() => ((window as any).__downloads as Array<{ name?: string }>).map(d => d.name).filter(Boolean));
    expect(names).toEqual(['model.urdf']);
    await expect(page.locator('#topbar-status')).toContainText('URDF downloaded as model.urdf');
  });
});

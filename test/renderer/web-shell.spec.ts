import { expect, test } from '@playwright/test';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIST_WEB = path.join(REPO_ROOT, 'dist-web');
const FIXTURE_DIR = path.join(REPO_ROOT, 'test', 'fixtures');
const LEAK_FIXTURE_DIR = path.join(REPO_ROOT, 'test', 'fixtures', 'leak_test');

// Files we will inject via the webkitdirectory fallback path. Browsers strip
// File System Access API from headless contexts unless granted explicit user
// gestures, so we use the FileList fallback that AppShell already supports.
const FIXTURE_FILES = [
  // The xacro file lives at the fixture root; we present it as if dropped from
  // a "fixtures" folder.
  { abs: path.join(FIXTURE_DIR, 'model.xacro'), rel: 'fixtures/model.xacro' },
  { abs: path.join(FIXTURE_DIR, 'xacro_pkg', 'package.xml'), rel: 'fixtures/xacro_pkg/package.xml' },
  { abs: path.join(FIXTURE_DIR, 'xacro_pkg', 'urdf', 'part.xacro'), rel: 'fixtures/xacro_pkg/urdf/part.xacro' },
  { abs: path.join(FIXTURE_DIR, 'xacro_pkg', 'config', 'test.yaml'), rel: 'fixtures/xacro_pkg/config/test.yaml' }
];

test.describe('web shell', () => {
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

  test('loads a xacro fixture via the webkitdirectory fallback, renders, moves a joint, exports a screenshot', async ({ page, browserName }) => {
    test.skip(browserName !== 'chromium', 'Headless Firefox does not honour webkitdirectory in CI.');

    const consoleErrors: string[] = [];
    page.on('pageerror', error => consoleErrors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') {
        consoleErrors.push(message.text());
      }
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
    await page.waitForTimeout(500);
    const afterFirst = await page.evaluate(() => (window as unknown as { __blobTracker: { live(): number } }).__blobTracker.live());

    // Alternate between two URDFs four times. Each switch generates one fresh
    // URL and revokes the previous-generation one. Live count must stay bounded
    // (1 mesh per load), not grow linearly.
    for (let i = 0; i < 4; i++) {
      const next = i % 2 === 0 ? altTargetValue : targetValue;
      await page.locator('#file-select').selectOption('');
      await page.locator('#file-select').selectOption(next);
      await expect(page.locator('[data-joint-slider="hinge"]')).toBeVisible({ timeout: 15_000 });
      await page.waitForTimeout(500);
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
});

async function startStaticServer(root: string): Promise<{ url: string; close(): Promise<void> }> {
  const server: Server = createServer((request, response) => {
    const requestUrl = new URL(request.url ?? '/', 'http://127.0.0.1');
    let pathname = decodeURIComponent(requestUrl.pathname);
    if (pathname === '/' || pathname === '') {
      pathname = '/index.html';
    }
    const filePath = path.resolve(root, `.${pathname}`);
    if (!filePath.startsWith(root) || !existsSync(filePath) || statSync(filePath).isDirectory()) {
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
    throw new Error('Could not start static server');
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
  if (filePath.endsWith('.json')) {
    return 'application/json';
  }
  return 'text/html';
}

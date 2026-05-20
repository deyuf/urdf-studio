import { expect, test } from '@playwright/test';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const DIST_WEB = path.join(REPO_ROOT, 'dist-web');
const FIXTURE_DIR = path.join(REPO_ROOT, 'test', 'fixtures');

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

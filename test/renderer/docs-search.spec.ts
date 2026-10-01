import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

let server: Server;
let url: string;
const root = path.resolve('dist-web');

test.beforeAll(async () => {
  server = createServer(async (request, response) => {
    const pathname = new URL(request.url || '/', 'http://localhost').pathname;
    const relative = decodeURIComponent(pathname).replace(/^\/+/, '');
    const file = path.resolve(root, relative.endsWith('/') || !relative ? `${relative}index.html` : relative);
    if (!file.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
    try {
      const content = await readFile(file);
      const mime: Record<string, string> = { '.html': 'text/html', '.js': 'application/javascript', '.json': 'application/json', '.css': 'text/css', '.png': 'image/png' };
      response.writeHead(200, { 'Content-Type': mime[path.extname(file)] || 'application/octet-stream' });
      response.end(content);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Test server missing address');
  url = `http://127.0.0.1:${address.port}`;
});

test.afterAll(async () => { if (server) await new Promise<void>(resolve => server.close(() => resolve())); });

test('documentation search works from the overview and nested pages', async ({ page }) => {
  await page.goto(`${url}/docs/`);
  await page.locator('#docs-search-open').click();
  await page.locator('#docs-search-input').fill('mimic');
  const result = page.locator('#docs-search-results a[href$="/docs/features/joints.html"]');
  await expect(result).toBeVisible();
  await result.click();
  await expect(page).toHaveURL(/\/docs\/features\/joints.html$/);
  await page.keyboard.press('ControlOrMeta+K');
  await page.locator('#docs-search-input').fill('zzzz-no-such-doc');
  await expect(page.locator('#docs-search-status')).toContainText('No results');
  await page.locator('#docs-search-input').press('Escape');
  await expect(page.locator('#docs-search')).not.toBeVisible();
});

test('project links stay in a collapsed footer on mobile and the social image is deployed', async ({ page, request }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(`${url}/docs/`);
  await expect(page.locator('.project-links')).not.toBeVisible();
  await page.locator('.project-switcher summary').click();
  await expect(page.locator('footer a[href="https://me.deyuf.org/"]')).toBeVisible();
  await expect(page.locator('footer a[href="https://historyofrobotics.deyuf.org/"]')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  const response = await request.get(`${url}/og-image.png`);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toBe('image/png');
  expect((await response.body()).length).toBeGreaterThan(1000);
});

test('the app keeps project links outside its toolbar and viewport', async ({ page }) => {
  await page.goto(url);
  if (await page.locator('dialog.onboarding').isVisible()) {
    await page.locator('[data-action="skip"]').click();
  }
  await expect(page.locator('#topbar .project-switcher')).toHaveCount(0);
  await expect(page.locator('.project-links')).not.toBeVisible();
  await page.locator('.project-switcher summary').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('footer a[href="https://me.deyuf.org/"]')).toBeVisible();
  const viewport = await page.locator('canvas#viewport').boundingBox();
  const footer = await page.locator('.project-footer').boundingBox();
  expect(viewport).not.toBeNull();
  expect(footer).not.toBeNull();
  expect(viewport!.y + viewport!.height).toBeLessThanOrEqual(footer!.y + 1);
});

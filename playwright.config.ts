import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/renderer',
  // Renderer tests load the full Three.js + URDF bundle on a fresh page.
  // 30s is enough locally but tight on slow CI runners during the first
  // worker boot, so give it more headroom and one retry on CI.
  timeout: 60_000,
  reporter: [['list'], ['html', { open: 'never' }]],
  workers: process.env.CI ? 2 : undefined,
  retries: process.env.CI ? 1 : 0,
  use: {
    launchOptions: process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : undefined,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    viewport: { width: 1280, height: 800 }
  }
});


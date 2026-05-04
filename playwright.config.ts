import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/renderer',
  timeout: 30000,
  use: {
    viewport: { width: 1280, height: 800 }
  }
});


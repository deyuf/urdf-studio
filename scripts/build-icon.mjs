// Render the vector master at the Marketplace's 256px size.
// CHROMIUM_PATH=/usr/bin/chromium node scripts/build-icon.mjs
import { chromium } from 'playwright';
import { readFile } from 'node:fs/promises';

const svg = await readFile(new URL('../media/icon.svg', import.meta.url), 'utf8');
const browser = await chromium.launch({
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {})
});
try {
  const page = await browser.newPage({ viewport: { width: 256, height: 256 }, deviceScaleFactor: 1 });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:256px;height:256px}</style>${svg}`);
  await page.locator('svg').screenshot({ path: new URL('../media/icon.png', import.meta.url).pathname, omitBackground: true });
} finally {
  await browser.close();
}

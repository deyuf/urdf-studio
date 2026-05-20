// UI audit: open every panel + interaction state, screenshot at multiple
// resolutions, log unexpected console errors / overflowing elements / clipped
// text / contrast ratios. Run after `npm run web:build`.

import { chromium } from 'playwright';
import { createReadStream, existsSync, statSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist-web');
const FRANKA = process.env.FRANKA_DIR ?? '/tmp/franka_description';
const OUT = path.join(REPO, 'media', 'ui-audit');
mkdirSync(OUT, { recursive: true });

const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/' || p === '') p = '/index.html';
  if (p.endsWith('/')) p += 'index.html';
  const fp = path.resolve(DIST, `.${p}`);
  if (!fp.startsWith(DIST) || !existsSync(fp) || statSync(fp).isDirectory()) {
    return res.writeHead(404).end();
  }
  const t = { '.js':'text/javascript','.css':'text/css','.html':'text/html','.png':'image/png' }[path.extname(fp)] ?? 'application/octet-stream';
  res.writeHead(200, { 'content-type': t });
  createReadStream(fp).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const URL_ROOT = `http://127.0.0.1:${server.address().port}`;

const findings = [];
const browser = await chromium.launch();

async function inspect(label, w, h, scheme) {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: scheme });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(`pageerror: ${e.message}`));
  page.on('console', m => {
    if (m.type() !== 'error') return;
    const t = m.text();
    if (/fonts\.(googleapis|gstatic)|net::ERR_/.test(t)) return;
    errs.push(`console: ${t.substring(0, 160)}`);
  });

  await page.goto(URL_ROOT);
  if (await page.locator('dialog.onboarding').isVisible()) {
    await page.locator('[data-action="skip"]').click();
  }
  await page.setInputFiles('#file-input', FRANKA);
  await page.locator('#file-select').waitFor();
  const fr3 = await page.locator('#file-select option').evaluateAll(opts => {
    const m = opts.find(o => /(^|\/)fr3\.urdf\.xacro$/.test(o.value));
    return m ? m.value : '';
  });
  await page.locator('#file-select').selectOption(fr3);
  await page.locator('[data-joint-slider]').first().waitFor({ timeout: 60000 });
  await page.waitForTimeout(1500);

  // Audit each panel.
  for (const tab of ['joints', 'inspector', 'checks', 'links', 'tools']) {
    await page.locator(`.tab[data-tab="${tab}"]`).click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(OUT, `${label}-${tab}.png`) });

    // Overflowing elements that are not by-design scroll containers. Filters
    // out the false-positive patterns:
    //   - <input type=text|search>: their value naturally scrolls intra-input.
    //   - elements inside an ancestor with overflow: auto / scroll: they scroll
    //     via the parent.
    //   - elements with text-overflow: ellipsis + overflow: hidden: handled.
    const overflows = await page.evaluate(() => {
      const out = [];
      for (const el of document.querySelectorAll('#app *')) {
        if (!(el instanceof HTMLElement)) continue;
        const cs = getComputedStyle(el);
        if (cs.overflow === 'auto' || cs.overflowX === 'auto' || cs.overflow === 'scroll' || cs.overflowX === 'scroll') continue;
        if (cs.textOverflow === 'ellipsis' && (cs.overflow === 'hidden' || cs.overflowX === 'hidden')) continue;
        if (el.tagName === 'INPUT') {
          const type = el.type;
          if (type === 'text' || type === 'search' || type === 'number') continue;
        }
        // Skip if an ancestor scrolls horizontally.
        let p = el.parentElement, scrollsInAncestor = false;
        while (p && p.id !== 'app') {
          const ps = getComputedStyle(p);
          if (ps.overflowX === 'auto' || ps.overflowX === 'scroll' || ps.overflow === 'auto' || ps.overflow === 'scroll') {
            scrollsInAncestor = true; break;
          }
          p = p.parentElement;
        }
        if (scrollsInAncestor) continue;
        if (el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) {
          out.push({ tag: el.tagName, cls: el.className, scrollW: el.scrollWidth, clientW: el.clientWidth, sample: (el.textContent || '').trim().slice(0, 40) });
        }
      }
      return out.slice(0, 10);
    });
    if (overflows.length) {
      findings.push({ label, tab, kind: 'overflow', items: overflows });
    }
  }

  // Open settings, check layout.
  await page.locator('#settings-btn').click();
  await page.locator('dialog#settings-dialog').waitFor();
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, `${label}-settings.png`) });
  await page.locator('dialog#settings-dialog button[value="cancel"]').click();
  await page.waitForTimeout(300);

  // Trigger error toast for visual.
  await page.setInputFiles('#file-input', path.join(REPO, 'test', 'fixtures', 'bad_urdf'));
  await page.locator('#file-select').waitFor();
  const bad = await page.locator('#file-select option').evaluateAll(opts => {
    const m = opts.find(o => /missing_mesh\.urdf$/.test(o.value));
    return m ? m.value : '';
  });
  await page.locator('#file-select').selectOption(bad);
  await page.locator('#toast-container .toast-error').waitFor();
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, `${label}-toast.png`) });

  // Reopen onboarding for screenshot.
  await page.locator('.toast-close').first().click();
  await page.locator('#help-btn').click();
  await page.locator('dialog.onboarding').waitFor();
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, `${label}-onboarding.png`) });

  if (errs.length) findings.push({ label, kind: 'console', items: errs });
  await ctx.close();
}

await inspect('1440-light', 1440, 900, 'light');
await inspect('1440-dark', 1440, 900, 'dark');
await inspect('1920-dark', 1920, 1080, 'dark');
await inspect('2560-dark', 2560, 1440, 'dark');

await browser.close();
server.close();

console.log('\nFindings:');
console.log(JSON.stringify(findings, null, 2));
console.log(`\n${findings.length} flagged item${findings.length === 1 ? '' : 's'}. Screenshots in ${path.relative(REPO, OUT)}/`);

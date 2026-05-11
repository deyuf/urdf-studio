import { promises as fs, createReadStream, existsSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
import { analyzeUrdf } from '../src/core/urdfAnalysis';
import type { PackageMap } from '../src/core/types';

const projectRoot = process.cwd();
const fr3Root = path.join(projectRoot, 'tmp-fr3');
const urdfPath = path.join(fr3Root, 'fr3.urdf');
const outputDir = path.join(projectRoot, 'media/screenshots');

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
    throw new Error('Could not start static server.');
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>(resolve => server.close(() => resolve()))
  };
}

function contentType(filePath: string): string {
  if (filePath.endsWith('.js')) return 'text/javascript';
  if (filePath.endsWith('.css')) return 'text/css';
  if (filePath.endsWith('.dae')) return 'model/vnd.collada+xml';
  if (filePath.endsWith('.stl')) return 'model/stl';
  if (filePath.endsWith('.png')) return 'image/png';
  return 'text/html';
}

async function main(): Promise<void> {
  const urdf = await fs.readFile(urdfPath, 'utf8');
  const packages: PackageMap = {
    franka_description: { name: 'franka_description', path: fr3Root, packageXml: path.join(fr3Root, 'package.xml') }
  };
  const metadata = analyzeUrdf(urdf, urdfPath, packages);

  await fs.mkdir(outputDir, { recursive: true });
  const server = await startStaticServer(projectRoot);
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 2 });
    const page = await context.newPage();
    page.on('console', msg => {
      if (msg.type() === 'error') console.error('renderer:', msg.text());
    });
    await page.goto(`${server.url}/test/renderer/harness.html`);
    // Inject VS Code dark theme CSS variables so the UI matches what users see
    // inside VS Code (the harness HTML has no theme of its own).
    await page.addStyleTag({ content: `
      :root {
        --vscode-font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, "Helvetica Neue", sans-serif;
        --vscode-foreground: #cccccc;
        --vscode-editor-background: #1e1e1e;
        --vscode-sideBar-background: #252526;
        --vscode-panel-border: #3c3c3c;
        --vscode-input-foreground: #cccccc;
        --vscode-input-background: #3c3c3c;
        --vscode-input-border: #3c3c3c;
        --vscode-button-foreground: #ffffff;
        --vscode-button-background: #0e639c;
        --vscode-button-hoverBackground: #1177bb;
        --vscode-toolbar-hoverBackground: #2a2d2e;
        --vscode-descriptionForeground: #9d9d9d;
        --vscode-list-hoverBackground: #2a2d2e;
        --vscode-list-activeSelectionBackground: #094771;
        --vscode-list-activeSelectionForeground: #ffffff;
        --vscode-errorForeground: #f48771;
        --vscode-editorWarning-foreground: #cca700;
        --vscode-editorInfo-foreground: #75beff;
        --vscode-textLink-foreground: #3794ff;
      }
      html, body { background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); margin: 0; }
    ` });
    await page.waitForFunction(() =>
      Array.isArray((window as { __messages?: unknown[] }).__messages) &&
      ((window as { __messages: { type: string }[] }).__messages).some(m => m.type === 'ready')
    );

    const loadMessage = {
      type: 'loadRobot',
      fileName: 'fr3.urdf',
      sourcePath: urdfPath,
      sourceBaseUri: `${server.url}/tmp-fr3/`,
      format: 'urdf',
      urdf,
      packageMap: { franka_description: `${server.url}/tmp-fr3` },
      metadata,
      semantic: { groups: [], states: [], diagnostics: [] },
      diagnostics: [],
      xacroArgs: [],
      xacroArgValues: {},
      renderSettings: { renderMode: 'visual', upAxis: '+Z' }
    };

    await page.evaluate(msg => {
      window.dispatchEvent(new MessageEvent('message', { data: msg }));
    }, loadMessage);

    // Wait for meshes to load — HUD clears when robot is revealed
    await page.waitForFunction(() => {
      const hud = document.getElementById('hud');
      return hud && !hud.textContent?.includes('Loading');
    }, { timeout: 30000 });
    await page.waitForTimeout(800);

    // Pose the arm a bit so it doesn't look like a stick (FR3 ready pose)
    const pose: Record<string, number> = {
      fr3_joint1: 0.0,
      fr3_joint2: -0.4,
      fr3_joint3: 0.0,
      fr3_joint4: -2.2,
      fr3_joint5: 0.0,
      fr3_joint6: 1.8,
      fr3_joint7: 0.785
    };
    for (const [name, value] of Object.entries(pose)) {
      await page.evaluate(({ n, v }) => {
        const el = document.querySelector(`[data-joint-slider="${n}"]`) as HTMLInputElement | null;
        if (el) {
          el.value = String(v);
          el.dispatchEvent(new Event('input', { bubbles: true }));
        }
      }, { n: name, v: value });
    }
    await page.waitForTimeout(400);
    await page.evaluate(() => (window as any).studioDebug?.fit?.());
    await page.waitForTimeout(300);

    // Main view: full UI with joints panel active
    await page.locator('[data-tab="joints"]').click();
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(outputDir, 'viewer-joints.png'), fullPage: false });

    await context.close();
  } finally {
    await browser.close();
    await server.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});

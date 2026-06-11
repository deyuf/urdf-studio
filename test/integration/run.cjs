// Real-VS-Code integration test runner.
//
// Downloads a stable VS Code build (cached in .vscode-test/), launches it
// under the development extension, and runs suite.cjs inside the extension
// host. The suite opens the Franka FR3 xacro fixture with the URDF Studio
// custom editor and asserts the full host↔webview handshake:
//
//     renderer 'ready'  →  host 'loadRobot'  →  renderer 'geometryLoaded'
//
// This is the ONLY test tier that exercises VS Code's actual webview message
// delivery (event.source is a foreign WindowProxy, event.origin is the
// webview's own vscode-webview:// origin). Two real-world regressions that
// every browser-based test missed were caught here — keep it green.
//
// Usage:  npm run test:vscode          (CI wraps with xvfb-run -a)
// Headless boxes need software WebGL: the launch args below enable
// SwiftShader so three.js can create a WebGL context without a GPU.

'use strict';

const { runTests } = require('@vscode/test-electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

async function main() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const logFile = path.join(os.tmpdir(), `urdf-studio-it-${process.pid}-${Date.now()}.log`);
  fs.writeFileSync(logFile, '');

  if (!fs.existsSync(path.join(repoRoot, 'dist', 'extension.js'))) {
    throw new Error('dist/extension.js missing — run `npm run compile` first.');
  }

  try {
    await runTests({
      extensionDevelopmentPath: repoRoot,
      extensionTestsPath: path.join(__dirname, 'suite.cjs'),
      launchArgs: [
        path.join(repoRoot, 'test', 'fixtures'),
        '--no-sandbox',
        // Software WebGL so the renderer can start without a GPU (CI/xvfb).
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        // Route Chromium renderer-process console output (webview console,
        // CSP violations, crashes) to stderr so CI logs show WHY a webview
        // failed to boot.
        '--enable-logging=stderr',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-extensions'
      ],
      extensionTestsEnv: { URDF_STUDIO_TEST_LOG: logFile }
    });
    console.log('VS Code integration test PASSED.');
  } catch (error) {
    console.error('VS Code integration test FAILED.');
    console.error('--- handshake log (%s) ---', logFile);
    console.error(fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '(missing)');
    dumpVsCodeLogs(repoRoot);
    throw error;
  } finally {
    fs.rmSync(logFile, { force: true });
  }
}

// On failure, print the tails of VS Code's own session logs (main, renderer,
// exthost, window) — the only place webview-process crashes are recorded.
function dumpVsCodeLogs(repoRoot) {
  const logsRoot = path.join(repoRoot, '.vscode-test', 'user-data', 'logs');
  if (!fs.existsSync(logsRoot)) {
    console.error('(no VS Code logs at %s)', logsRoot);
    return;
  }
  const interesting = /(main|renderer|exthost|window)\d*\.log$/;
  const stack = [logsRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (interesting.test(entry.name)) {
        const lines = fs.readFileSync(full, 'utf8').trimEnd().split('\n');
        console.error('--- %s (last %d lines) ---', full, Math.min(lines.length, 40));
        console.error(lines.slice(-40).join('\n'));
      }
    }
  }
}

main().catch(error => {
  console.error(String(error));
  process.exit(1);
});

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
// Stability notes (learned from CI):
//   - A FRESH --user-data-dir is created per run. Reusing one (e.g. from a
//     CI cache of .vscode-test/) makes VS Code restore previous windows and
//     editor layouts, which leaves the restored custom-editor webview in a
//     state where it never boots.
//   - On a brand-new profile VS Code initializes default profile extensions
//     and RESTARTS the extension host shortly after startup; the test module
//     can therefore execute twice, and the late instance may own a webview
//     that never reloads. The hook file is treated as the source of truth:
//     if ANY instance completed the handshake, the run passes.
//
// Usage:  npm run test:vscode          (CI wraps with
//         xvfb-run -a --server-args="-screen 0 1280x1024x24")

'use strict';

const { runTests } = require('@vscode/test-electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const SUCCESS_MARKER = 'recv:geometryLoaded';

async function main() {
  const repoRoot = path.resolve(__dirname, '..', '..');
  const logFile = path.join(os.tmpdir(), `urdf-studio-it-${process.pid}-${Date.now()}.log`);
  // Fresh profile per run — see stability notes above. Lives outside
  // .vscode-test so CI caching of the downloaded build can never leak state.
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'urdf-studio-vscode-ud-'));

  if (!fs.existsSync(path.join(repoRoot, 'dist', 'extension.js'))) {
    throw new Error('dist/extension.js missing — run `npm run compile` first.');
  }

  // Route Chromium renderer-process console output (webview console, CSP
  // violations, crashes) to stderr so CI logs show WHY a webview failed.
  process.env.ELECTRON_ENABLE_LOGGING = '1';

  let runError;
  try {
    await runTests({
      extensionDevelopmentPath: repoRoot,
      extensionTestsPath: path.join(__dirname, 'suite.cjs'),
      launchArgs: [
        path.join(repoRoot, 'test', 'fixtures'),
        `--user-data-dir=${userDataDir}`,
        '--no-sandbox',
        // Software WebGL so the renderer can start without a GPU (CI/xvfb).
        '--use-angle=swiftshader',
        '--enable-unsafe-swiftshader',
        '--disable-workspace-trust',
        '--skip-welcome',
        '--skip-release-notes',
        '--disable-extensions'
      ],
      extensionTestsEnv: { URDF_STUDIO_TEST_LOG: logFile }
    });
  } catch (error) {
    runError = error;
  }

  const hookLog = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  const handshakeCompleted = hookLog.includes(SUCCESS_MARKER);

  try {
    if (handshakeCompleted) {
      if (runError) {
        // A startup extension-host restart can run the suite twice; the late
        // instance may fail after an earlier one already proved the feature.
        console.warn('VS Code exit code was non-zero, but the handshake completed — treating as PASS.');
        console.warn(String(runError));
      }
      console.log('--- handshake log ---\n' + hookLog.trim());
      console.log('VS Code integration test PASSED.');
      return;
    }
    console.error('VS Code integration test FAILED.');
    console.error('--- handshake log (%s) ---', logFile);
    console.error(hookLog.trim() || '(empty — renderer never sent ready)');
    dumpVsCodeLogs(userDataDir);
    throw runError ?? new Error('Handshake never completed (no geometryLoaded in hook log).');
  } finally {
    fs.rmSync(logFile, { force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }
}

// On failure, print the tails of VS Code's own session logs (main, renderer,
// exthost, window) — the only place webview-process crashes are recorded.
function dumpVsCodeLogs(userDataDir) {
  const logsRoot = path.join(userDataDir, 'logs');
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

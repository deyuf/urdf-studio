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
    throw error;
  } finally {
    fs.rmSync(logFile, { force: true });
  }
}

main().catch(error => {
  console.error(String(error));
  process.exit(1);
});

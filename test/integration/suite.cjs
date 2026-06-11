// Runs INSIDE the VS Code extension host (see run.cjs).
//
// Opens test/fixtures/franka_description/robots/fr3/fr3.urdf.xacro with the
// URDF Studio custom editor and watches the URDF_STUDIO_TEST_LOG hook file
// (written by src/extension.ts) for the host↔webview handshake. Success is
// the renderer's 'geometryLoaded' reply — it is only sent after the webview
// accepted 'loadRobot', parsed the URDF, settled every mesh load, and
// revealed the robot.
//
// Startup in a fresh VS Code profile is racy (extension-host restart while
// initializing default profile extensions, webviews that never boot when the
// window is mid-reload), so the suite retries: if the webview shows no sign
// of life within ATTEMPT_TIMEOUT_MS, close every editor and open it again.

'use strict';

const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');

const TOTAL_TIMEOUT_MS = 120_000;
const ATTEMPT_TIMEOUT_MS = 25_000;
const POLL_MS = 500;

exports.run = async function run() {
  const logFile = process.env.URDF_STUDIO_TEST_LOG;
  if (!logFile) {
    throw new Error('URDF_STUDIO_TEST_LOG is not set — launch through run.cjs.');
  }

  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    throw new Error('No workspace folder — run.cjs must open test/fixtures.');
  }
  const fixture = path.join(workspaceRoot, 'franka_description', 'robots', 'fr3', 'fr3.urdf.xacro');
  if (!fs.existsSync(fixture)) {
    throw new Error(`Fixture missing: ${fixture}`);
  }
  const uri = vscode.Uri.file(fixture);

  const deadline = Date.now() + TOTAL_TIMEOUT_MS;
  let attempt = 0;
  let log = '';
  while (Date.now() < deadline) {
    attempt += 1;
    console.log(`[suite] attempt ${attempt}: opening ${fixture}`);
    await vscode.commands.executeCommand('vscode.openWith', uri, 'urdfStudio.preview');

    const attemptDeadline = Math.min(Date.now() + ATTEMPT_TIMEOUT_MS, deadline);
    while (Date.now() < attemptDeadline) {
      log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
      if (log.includes('recv:geometryLoaded')) {
        console.log('[suite] handshake complete:\n' + log.trim());
        return;
      }
      await new Promise(resolve => setTimeout(resolve, POLL_MS));
    }

    // No handshake this attempt — the webview may be orphaned (extension-host
    // restart) or never booted (window was mid-reload). Force a fresh webview.
    console.log(`[suite] attempt ${attempt} saw no handshake; closing editors and retrying. Hook so far: ${log.trim() || '(empty)'}`);
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }

  const diagnostics = vscode.languages.getDiagnostics(uri)
    .map(d => `${d.severity}:${String(d.code)}:${d.message}`)
    .join('\n');
  throw new Error(
    'Robot never revealed in the webview (no geometryLoaded).\n' +
    `Handshake log:\n${log.trim() || '(empty — renderer never sent ready)'}\n` +
    `Diagnostics:\n${diagnostics || '(none)'}`
  );
};

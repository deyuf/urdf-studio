// Runs INSIDE the VS Code extension host (see run.cjs).
//
// Opens test/fixtures/franka_description/robots/fr3/fr3.urdf.xacro with the
// URDF Studio custom editor and watches the URDF_STUDIO_TEST_LOG hook file
// (written by src/extension.ts) for the host↔webview handshake. Success is
// the renderer's 'geometryLoaded' reply — it is only sent after the webview
// accepted 'loadRobot', expanded nothing further, parsed the URDF, settled
// every mesh load, and revealed the robot.

'use strict';

const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');

const HANDSHAKE_TIMEOUT_MS = 90_000;

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

  console.log('[suite] opening', fixture);
  await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(fixture), 'urdfStudio.preview');
  console.log('[suite] custom editor opened; waiting for geometryLoaded...');

  const deadline = Date.now() + HANDSHAKE_TIMEOUT_MS;
  let log = '';
  while (Date.now() < deadline) {
    log = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    if (log.includes('recv:geometryLoaded')) {
      console.log('[suite] handshake complete:\n' + log.trim());
      return;
    }
    if (log.includes('error:') || log.includes('recv:__rendererError')) {
      break; // fail fast with the log below
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  const uri = vscode.Uri.file(fixture);
  const diagnostics = vscode.languages.getDiagnostics(uri)
    .map(d => `${d.severity}:${String(d.code)}:${d.message}`)
    .join('\n');
  throw new Error(
    'Robot never revealed in the webview (no geometryLoaded).\n' +
    `Handshake log:\n${log.trim() || '(empty — renderer never sent ready)'}\n` +
    `Diagnostics:\n${diagnostics || '(none)'}`
  );
};

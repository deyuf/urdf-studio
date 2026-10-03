// Runs INSIDE the VS Code extension host (see run.cjs).
//
// Validates loading, source saving, pose restoration, and included-file reload.
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
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

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
        await verifyBusinessFlows(workspaceRoot, logFile);
        fs.appendFileSync(logFile, 'suite:complete\n');
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

// Exercise real controls over Electron's test-only loopback CDP connection.
// No product commands or renderer messages are added for these tests.
async function verifyBusinessFlows(workspaceRoot, logFile) {
  const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.URDF_STUDIO_CDP_PORT}`);
  const dir = fs.mkdtempSync(path.join(workspaceRoot, 'integration-'));
  const model = path.join(dir, 'robot.urdf');
  const xacro = path.join(dir, 'robot.xacro');
  const included = path.join(dir, 'geometry.xacro');
  const source = `<?xml version="1.0"?>
<robot name="integration_bot">
  <link name="base"><visual><geometry><box size="0.2 0.2 0.2"/></geometry></visual></link>
  <link name="tip"><visual><geometry><box size="0.1 0.1 0.1"/></geometry></visual></link>
  <joint name="hinge" type="revolute"><parent link="base"/><child link="tip"/>
    <axis xyz="0 0 1"/><limit lower="-1" upper="1" effort="1" velocity="1"/></joint>
</robot>`;
  const checkpoint = name => { console.log(`[suite] ${name} passed`); fs.appendFileSync(logFile, `suite:${name}\n`); };
  try {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.writeFileSync(model, source);
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(model), 'urdfStudio.preview');
    let frame = await findPreview(browser, 'hinge');
    const value = frame.locator('[data-joint-number="hinge"]');
    await value.fill('0.375');
    await value.dispatchEvent('change');
    await frame.locator('#save-pose').click();
    // Await the host's received request before disposing the webview. Restoration
    // below proves the async workspaceState write completed and was consumed.
    await until(() => fs.readFileSync(logFile, 'utf8').includes('recv:requestSavePose'), 'save-pose request');
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(model), 'urdfStudio.preview');
    frame = await findPreview(browser, 'hinge');
    await until(async () => Number(await frame.locator('[data-joint-number="hinge"]').inputValue()) === 0.375, 'saved pose restoration');
    checkpoint('pose-restored');

    await frame.locator('.tab[data-tab="source"]').click();
    await frame.locator('#panel-source .source-edit-toggle').click();
    const editor = frame.locator('#panel-source .cm-content');
    await editor.click();
    await editor.press('Control+End');
    await editor.press('Enter');
    await editor.pressSequentially('<!-- saved by integration test -->');
    // Live preview replaces the source pane, so reacquire the current editor
    // after its text reaches the renderer and then invoke its save keybinding.
    const edited = frame.locator('#panel-source .cm-content');
    await edited.press('Control+s');
    await until(() => fs.readFileSync(model, 'utf8').includes('<!-- saved by integration test -->'), 'source saved on disk');
    assert.match(fs.readFileSync(model, 'utf8'), /<joint name="hinge"/);
    checkpoint('source-saved');

    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    fs.writeFileSync(included, '<robot xmlns:xacro="http://www.ros.org/wiki/xacro"><link name="before_reload"/></robot>');
    fs.writeFileSync(xacro, '<robot name="watcher_bot" xmlns:xacro="http://www.ros.org/wiki/xacro"><xacro:include filename="geometry.xacro"/></robot>');
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.file(xacro), 'urdfStudio.preview');
    frame = await findPreview(browser);
    await frame.locator('.tab[data-tab="links"]').click();
    await until(async () => (await frame.locator('#panel-links').textContent()).includes('before_reload'), 'included link before edit');
    fs.writeFileSync(included, '<robot xmlns:xacro="http://www.ros.org/wiki/xacro"><link name="after_reload"/></robot>');
    await until(async () => (await frame.locator('#panel-links').textContent()).includes('after_reload'), 'included-file watcher reload');
    assert.ok(!(await frame.locator('#panel-links').textContent()).includes('before_reload'));
    checkpoint('include-reloaded');
  } finally {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await browser.close(); // Disconnects CDP; runTests owns the Electron process.
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function findPreview(browser, joint) {
  let result;
  await until(async () => {
    for (const context of browser.contexts()) {
      for (const page of context.pages()) {
        for (const frame of page.frames()) {
          try {
            if (await frame.locator('#save-pose').count()
                && (!joint || await frame.locator(`[data-joint-number="${joint}"]`).count())
                && await frame.locator('#viewport').evaluate(canvas => canvas.ownerDocument.defaultView.getComputedStyle(canvas).opacity === '1')) {
              result = frame;
              return true;
            }
          } catch { /* Frame may detach while VS Code replaces an editor. */ }
        }
      }
    }
    return false;
  }, 'loaded preview frame');
  return result;
}

async function until(predicate, label, timeout = 30_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${label}`);
}

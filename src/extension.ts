import * as vscode from 'vscode';
import path from 'node:path';
import { discoverPackages } from './core/packageMap';
import { renderRobotDocument, setLogger } from './core/xacro';
import { analyzeUrdf } from './core/urdfAnalysis';
import { loadSemanticMetadata } from './core/srdf';
import type { PackageMap, PreviewState, StudioDiagnostic } from './core/types';

const VIEW_TYPE = 'urdfStudio.preview';

let outputChannel: vscode.OutputChannel;

export function log(message: string): void {
  outputChannel?.appendLine(`[${new Date().toISOString()}] ${message}`);
}

interface WebviewPackageMap {
  [packageName: string]: string;
}

interface ActivePreview {
  document: UrdfDocument;
  panel: vscode.WebviewPanel;
  xacroArgs: Record<string, unknown>;
}

class UrdfDocument implements vscode.CustomDocument {
  constructor(public readonly uri: vscode.Uri) {}
  dispose(): void {}
}

class UrdfStudioProvider implements vscode.CustomReadonlyEditorProvider<UrdfDocument> {
  private readonly diagnostics: vscode.DiagnosticCollection;
  private readonly previews = new Set<ActivePreview>();
  private activePreview: ActivePreview | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.diagnostics = vscode.languages.createDiagnosticCollection('urdfStudio');
    context.subscriptions.push(this.diagnostics);
  }

  openCustomDocument(uri: vscode.Uri): UrdfDocument {
    return new UrdfDocument(uri);
  }

  async resolveCustomEditor(
    document: UrdfDocument,
    webviewPanel: vscode.WebviewPanel,
    _token: vscode.CancellationToken
  ): Promise<void> {
    if (document.uri.scheme !== 'file') {
      log(`Skipping non-file scheme: ${document.uri.scheme}`);
      webviewPanel.webview.html = '<html><body><p>Preview not available in diff view.</p></body></html>';
      return;
    }

    const preview: ActivePreview = {
      document,
      panel: webviewPanel,
      xacroArgs: this.getDefaultXacroArgs()
    };
    this.previews.add(preview);
    this.activePreview = preview;

    // Discover packages up front so we can set localResourceRoots once.
    // Mutating webview.options after the webview has loaded forces a full reload
    // (causing the visible flicker on first load).
    const config = vscode.workspace.getConfiguration('urdfStudio');
    const packageRoots = this.packageRoots(config);
    let initialPackages: PackageMap = {};
    try {
      initialPackages = await discoverPackages(packageRoots);
    } catch {
      initialPackages = {};
    }
    // Also include the URDF file's own directory hierarchy so that meshes
    // referenced via relative paths or package:// URIs that resolve to the
    // same tree are accessible without a later webview.options mutation.
    const initialRoots = this.localResourceRoots(initialPackages, document.uri);

    webviewPanel.webview.options = {
      enableScripts: true,
      localResourceRoots: initialRoots
    };
    webviewPanel.webview.html = this.renderHtml(webviewPanel.webview);

    webviewPanel.onDidChangeViewState(() => {
      if (webviewPanel.active) {
        this.activePreview = preview;
      }
    });
    webviewPanel.onDidDispose(() => {
      this.previews.delete(preview);
      if (this.activePreview === preview) {
        this.activePreview = Array.from(this.previews).at(-1);
      }
      this.diagnostics.delete(document.uri);
    });

    webviewPanel.webview.onDidReceiveMessage(async message => {
      switch (message?.type) {
        case 'ready':
          await this.loadIntoWebview(preview);
          break;
        case 'reloadWithXacroArgs':
          preview.xacroArgs = { ...this.getDefaultXacroArgs(), ...(message.args ?? {}) };
          await this.loadIntoWebview(preview);
          break;
        case 'requestSavePose':
          await this.savePreviewState(document.uri, { pose: message.pose, camera: message.camera });
          void vscode.window.setStatusBarMessage('URDF Studio pose saved.', 2500);
          break;
        case 'exportPoseResult':
          await this.openPoseExport(document.uri, message.pose, message.camera);
          break;
        case 'screenshotResult':
          await this.saveScreenshot(document.uri, message.dataUrl);
          break;
        case 'geometryLoaded':
          void vscode.window.setStatusBarMessage(
            `URDF Studio: ${message.linkCount ?? 0} links, ${message.jointCount ?? 0} joints, ${message.movableJointCount ?? 0} movable.`,
            4000
          );
          break;
        default:
          break;
      }
    });
  }

  async openPreviewForActiveEditor(): Promise<void> {
    const uri = vscode.window.activeTextEditor?.document.uri;
    if (!uri) {
      void vscode.window.showInformationMessage('Open a URDF or xacro file first.');
      return;
    }
    await vscode.commands.executeCommand('vscode.openWith', uri, VIEW_TYPE);
  }

  postCommand(type: 'recenter' | 'exportPose' | 'captureScreenshot'): void {
    const preview = this.activePreview;
    if (!preview) {
      void vscode.window.showInformationMessage('Open a URDF Studio preview first.');
      return;
    }
    void preview.panel.webview.postMessage({ type });
  }

  private async loadIntoWebview(preview: ActivePreview): Promise<void> {
    try {
      await this.doLoadIntoWebview(preview);
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      log(`Failed to load preview: ${msg}`);
      this.updateDiagnostics(preview.document.uri, [{ severity: 'error', message: msg, code: 'preview.loadFailed', file: preview.document.uri.fsPath }]);
    }
  }

  private async doLoadIntoWebview(preview: ActivePreview): Promise<void> {
    const config = vscode.workspace.getConfiguration('urdfStudio');
    const packageRoots = this.packageRoots(config);
    const packages = await discoverPackages(packageRoots);
    // NEVER re-assign webview.options here; doing so reloads the webview
    // and causes a visible flash.  The initial roots set in resolveCustomEditor
    // already include packages + the URDF directory tree.

    log(`Loading: ${preview.document.uri.fsPath}`);
    const rendered = await renderRobotDocument(preview.document.uri.fsPath, packages, preview.xacroArgs);
    const metadata = analyzeUrdf(rendered.urdf, preview.document.uri.fsPath, packages);
    const semanticFiles = this.semanticFiles(config);
    const semantic = await loadSemanticMetadata(semanticFiles, packages);
    const diagnostics = [...rendered.diagnostics, ...metadata.diagnostics, ...semantic.diagnostics];
    this.updateDiagnostics(preview.document.uri, diagnostics);

    await preview.panel.webview.postMessage({
      type: 'loadRobot',
      documentUri: preview.document.uri.toString(),
      fileName: path.basename(preview.document.uri.fsPath),
      sourcePath: preview.document.uri.fsPath,
      sourceBaseUri: this.asDirectoryWebviewUri(preview.panel.webview, path.dirname(preview.document.uri.fsPath)),
      format: rendered.format,
      urdf: rendered.urdf,
      packageMap: this.toWebviewPackageMap(preview.panel.webview, packages),
      metadata,
      semantic,
      diagnostics,
      xacroArgs: rendered.xacroArgs,
      xacroArgValues: preview.xacroArgs,
      renderSettings: {
        renderMode: config.get<string>('defaultRenderMode', 'visual'),
        upAxis: config.get<string>('upAxis', '+Z')
      },
      savedState: this.getPreviewState(preview.document.uri)
    });
  }

  private renderHtml(webview: vscode.Webview): string {
    const nonce = createNonce();
    const rendererUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'renderer.js'));
    const stylesUri = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'media', 'styles.css'));
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} data:`,
      `font-src ${webview.cspSource}`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
      `connect-src ${webview.cspSource} https: data: blob:`
    ].join('; ');

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link nonce="${nonce}" rel="stylesheet" href="${stylesUri}">
  <title>URDF Studio</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" type="module" src="${rendererUri}"></script>
</body>
</html>`;
  }

  private packageRoots(config: vscode.WorkspaceConfiguration): string[] {
    const workspaceRoots = vscode.workspace.workspaceFolders?.map(folder => folder.uri.fsPath) ?? [];
    const extraRoots = config.get<string[]>('packageRoots', []).map(root => this.resolveWorkspacePath(root));
    return [...workspaceRoots, ...extraRoots];
  }

  private semanticFiles(config: vscode.WorkspaceConfiguration): string[] {
    return config.get<string[]>('semanticFiles', []).map(file => this.resolveWorkspacePath(file));
  }

  private resolveWorkspacePath(value: string): string {
    if (path.isAbsolute(value)) {
      return value;
    }
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    return path.resolve(workspaceRoot, value);
  }

  private defaultLocalResourceRoots(): vscode.Uri[] {
    return [
      this.context.extensionUri,
      ...(vscode.workspace.workspaceFolders?.map(folder => folder.uri) ?? [])
    ];
  }

  private localResourceRoots(packages: PackageMap, documentUri?: vscode.Uri): vscode.Uri[] {
    const roots = new Map<string, vscode.Uri>();
    for (const uri of this.defaultLocalResourceRoots()) {
      roots.set(uri.toString(), uri);
    }
    for (const entry of Object.values(packages)) {
      const uri = vscode.Uri.file(entry.path);
      roots.set(uri.toString(), uri);
    }
    // Walk up from the URDF file's directory so that meshes referenced via
    // relative paths are always accessible.
    if (documentUri) {
      let dir = path.dirname(documentUri.fsPath);
      const parsed = path.parse(dir);
      // Add up to 4 ancestor directories (covers typical ROS workspace layouts).
      for (let i = 0; i < 4 && dir !== parsed.root; i++) {
        const uri = vscode.Uri.file(dir);
        roots.set(uri.toString(), uri);
        dir = path.dirname(dir);
      }
    }
    return Array.from(roots.values());
  }

  private toWebviewPackageMap(webview: vscode.Webview, packages: PackageMap): WebviewPackageMap {
    return Object.fromEntries(Object.entries(packages).map(([name, entry]) => [
      name,
      this.asDirectoryWebviewUri(webview, entry.path)
    ]));
  }

  private asDirectoryWebviewUri(webview: vscode.Webview, directoryPath: string): string {
    const uri = webview.asWebviewUri(vscode.Uri.file(`${directoryPath}${path.sep}`)).toString();
    return uri.endsWith('/') ? uri : `${uri}/`;
  }

  private updateDiagnostics(uri: vscode.Uri, diagnostics: StudioDiagnostic[]): void {
    this.diagnostics.set(uri, diagnostics.map(diagnostic => {
      const line = Math.max(0, (diagnostic.line ?? 1) - 1);
      const severity = diagnostic.severity === 'error'
        ? vscode.DiagnosticSeverity.Error
        : diagnostic.severity === 'warning'
          ? vscode.DiagnosticSeverity.Warning
          : vscode.DiagnosticSeverity.Information;
      const item = new vscode.Diagnostic(
        new vscode.Range(new vscode.Position(line, 0), new vscode.Position(line, 1)),
        diagnostic.message,
        severity
      );
      item.code = diagnostic.code;
      item.source = 'URDF Studio';
      return item;
    }));
  }

  private getDefaultXacroArgs(): Record<string, unknown> {
    return vscode.workspace.getConfiguration('urdfStudio').get<Record<string, unknown>>('defaultXacroArgs', {});
  }

  private stateKey(uri: vscode.Uri): string {
    return `urdfStudio.previewState:${uri.toString()}`;
  }

  private getPreviewState(uri: vscode.Uri): PreviewState | undefined {
    return this.context.workspaceState.get<PreviewState>(this.stateKey(uri));
  }

  private async savePreviewState(uri: vscode.Uri, state: PreviewState): Promise<void> {
    await this.context.workspaceState.update(this.stateKey(uri), state);
  }

  private async openPoseExport(uri: vscode.Uri, pose: unknown, camera: unknown): Promise<void> {
    const document = await vscode.workspace.openTextDocument({
      language: 'json',
      content: `${JSON.stringify({
        source: uri.fsPath,
        exportedAt: new Date().toISOString(),
        pose,
        camera
      }, null, 2)}\n`
    });
    await vscode.window.showTextDocument(document, { preview: false });
  }

  private async saveScreenshot(uri: vscode.Uri, dataUrl: string | undefined): Promise<void> {
    if (!dataUrl?.startsWith('data:image/png;base64,')) {
      void vscode.window.showWarningMessage('URDF Studio could not capture a screenshot.');
      return;
    }
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri ?? vscode.Uri.file(path.dirname(uri.fsPath));
    const screenshotDir = vscode.Uri.joinPath(workspaceRoot, 'urdf-studio-screenshots');
    await vscode.workspace.fs.createDirectory(screenshotDir);
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const out = vscode.Uri.joinPath(screenshotDir, `${path.basename(uri.fsPath)}-${stamp}.png`);
    const bytes = Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64');
    await vscode.workspace.fs.writeFile(out, bytes);
    void vscode.window.showInformationMessage(`URDF Studio screenshot saved: ${vscode.workspace.asRelativePath(out)}`);
  }
}

export function activate(context: vscode.ExtensionContext): void {
  outputChannel = vscode.window.createOutputChannel('URDF Studio');
  context.subscriptions.push(outputChannel);
  log('URDF Studio activated');
  setLogger(log);

  const provider = new UrdfStudioProvider(context);
  context.subscriptions.push(vscode.window.registerCustomEditorProvider(
    VIEW_TYPE,
    provider,
    {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false
    }
  ));

  context.subscriptions.push(
    vscode.commands.registerCommand('urdfStudio.openPreview', () => provider.openPreviewForActiveEditor()),
    vscode.commands.registerCommand('urdfStudio.recenter', () => provider.postCommand('recenter')),
    vscode.commands.registerCommand('urdfStudio.exportPose', () => provider.postCommand('exportPose')),
    vscode.commands.registerCommand('urdfStudio.captureScreenshot', () => provider.postCommand('captureScreenshot'))
  );
}

export function deactivate(): void {}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 32; i += 1) {
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return nonce;
}


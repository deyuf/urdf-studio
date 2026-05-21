import * as vscode from 'vscode';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import './core/io.node';
import { discoverPackages } from './core/packageMap';
import { renderRobotDocument, setLogger } from './core/xacro';
import { analyzeUrdf } from './core/urdfAnalysis';
import { loadSemanticMetadata, mergeDisableCollisionsIntoSrdf, parseSrdf } from './core/srdf';
import { escapeXmlText } from './core/escapeXml';
import type { DisableCollisionEntry, PackageMap, PoseBookmark, PreviewState, RobotMetadata, StudioDiagnostic } from './core/types';
import { registerLanguageFeatures } from './languageFeatures';

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
  watcher: vscode.FileSystemWatcher | undefined;
  watchedFiles: Set<string>;
  reloadTimer: ReturnType<typeof setTimeout> | undefined;
  metadata?: RobotMetadata;
  semanticSourceFile?: string;
  pendingState?: { pose: Record<string, number>; camera?: PreviewState['camera'] };
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
      xacroArgs: this.getDefaultXacroArgs(),
      watcher: undefined,
      watchedFiles: new Set(),
      reloadTimer: undefined
    };
    this.previews.add(preview);
    this.activePreview = preview;

    const config = vscode.workspace.getConfiguration('urdfStudio');
    const packageRoots = this.packageRoots(config);
    let initialPackages: PackageMap = {};
    try {
      initialPackages = await discoverPackages(packageRoots);
    } catch {
      initialPackages = {};
    }
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
      preview.watcher?.dispose();
      if (preview.reloadTimer) {
        clearTimeout(preview.reloadTimer);
      }
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
        case 'requestSaveBookmark':
          await this.saveBookmark(document.uri, message.name, message.pose, message.camera);
          await this.broadcastBookmarks(preview);
          break;
        case 'requestDeleteBookmark':
          await this.deleteBookmark(document.uri, message.name);
          await this.broadcastBookmarks(preview);
          break;
        case 'requestRenameBookmark':
          await this.renameBookmark(document.uri, message.from, message.to);
          await this.broadcastBookmarks(preview);
          break;
        case 'exportPoseResult':
          await this.openPoseExport(document.uri, message.pose, message.camera);
          break;
        case 'screenshotResult':
          await this.saveScreenshot(document.uri, message.dataUrl);
          break;
        case 'requestSaveBom':
          await this.saveBom(document.uri, message.csv, message.filename);
          break;
        case 'requestSaveReport':
          await this.saveReport(document.uri, message.base64, message.filename);
          break;
        case 'requestRevealRange':
          await this.revealRangeForLink(document.uri, message.line, message.link);
          break;
        case 'geometryLoaded':
          void vscode.window.setStatusBarMessage(
            `URDF Studio: ${message.linkCount ?? 0} links, ${message.jointCount ?? 0} joints, ${message.movableJointCount ?? 0} movable.`,
            4000
          );
          break;
        case 'requestWriteDisableCollisions':
          await this.writeDisableCollisions(preview, message.entries ?? []);
          break;
        case 'poseSnapshot':
          this.capturePoseSnapshot(preview, message.pose ?? {}, message.camera);
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

  postCommand(type: 'recenter' | 'exportPose' | 'captureScreenshot' | 'sampleReachability'): void {
    const preview = this.activePreview;
    if (!preview) {
      void vscode.window.showInformationMessage('Open a URDF Studio preview first.');
      return;
    }
    void preview.panel.webview.postMessage({ type });
  }

  getActiveMetadata(uri: vscode.Uri): RobotMetadata | undefined {
    for (const preview of this.previews) {
      if (preview.document.uri.toString() === uri.toString()) {
        return preview.metadata;
      }
    }
    return undefined;
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

    log(`Loading: ${preview.document.uri.fsPath}`);
    const rendered = await renderRobotDocument(preview.document.uri.fsPath, packages, preview.xacroArgs);
    const metadata = analyzeUrdf(rendered.urdf, preview.document.uri.fsPath, packages);
    const semanticFiles = this.semanticFiles(config);
    const semantic = await loadSemanticMetadata(semanticFiles, packages);
    const diagnostics = [...rendered.diagnostics, ...metadata.diagnostics, ...semantic.diagnostics];
    this.updateDiagnostics(preview.document.uri, diagnostics);

    preview.metadata = metadata;
    preview.semanticSourceFile = semantic.sourceFile;

    this.refreshWatcher(preview, [preview.document.uri.fsPath, ...rendered.includedFiles]);

    const savedState = preview.pendingState ?? this.getPreviewState(preview.document.uri);
    preview.pendingState = undefined;

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
      savedState,
      bookmarks: this.getBookmarks(preview.document.uri)
    });
  }

  private refreshWatcher(preview: ActivePreview, filePaths: string[]): void {
    const wantedFiles = new Set(filePaths.filter(Boolean).map(filePath => path.resolve(filePath)));
    if (preview.watchedFiles.size === wantedFiles.size && Array.from(wantedFiles).every(file => preview.watchedFiles.has(file))) {
      return;
    }
    preview.watcher?.dispose();
    preview.watchedFiles = wantedFiles;
    if (wantedFiles.size === 0) {
      preview.watcher = undefined;
      return;
    }
    const pattern = `{${Array.from(wantedFiles).map(escapeBraces).join(',')}}`;
    const watcher = vscode.workspace.createFileSystemWatcher(pattern, false, false, false);
    const triggerReload = (uri: vscode.Uri) => {
      if (!preview.watchedFiles.has(path.resolve(uri.fsPath))) {
        return;
      }
      this.scheduleReload(preview, 'changed');
    };
    watcher.onDidChange(triggerReload);
    watcher.onDidCreate(triggerReload);
    watcher.onDidDelete(triggerReload);
    preview.watcher = watcher;
  }

  private scheduleReload(preview: ActivePreview, _reason: string): void {
    if (preview.reloadTimer) {
      clearTimeout(preview.reloadTimer);
    }
    preview.reloadTimer = setTimeout(() => {
      preview.reloadTimer = undefined;
      void preview.panel.webview.postMessage({ type: 'requestPoseSnapshot' });
      // The webview will reply with `poseSnapshot`; we capture it and reload.
    }, 200);
  }

  private capturePoseSnapshot(preview: ActivePreview, pose: Record<string, number>, camera: PreviewState['camera']): void {
    preview.pendingState = { pose, camera };
    void this.loadIntoWebview(preview);
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
    if (documentUri) {
      let dir = path.dirname(documentUri.fsPath);
      const parsed = path.parse(dir);
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

  private bookmarksKey(uri: vscode.Uri): string {
    return `urdfStudio.bookmarks:${uri.toString()}`;
  }

  private getPreviewState(uri: vscode.Uri): PreviewState | undefined {
    return this.context.workspaceState.get<PreviewState>(this.stateKey(uri));
  }

  private async savePreviewState(uri: vscode.Uri, state: PreviewState): Promise<void> {
    await this.context.workspaceState.update(this.stateKey(uri), state);
  }

  private getBookmarks(uri: vscode.Uri): PoseBookmark[] {
    return this.context.workspaceState.get<PoseBookmark[]>(this.bookmarksKey(uri), []);
  }

  private async setBookmarks(uri: vscode.Uri, bookmarks: PoseBookmark[]): Promise<void> {
    await this.context.workspaceState.update(this.bookmarksKey(uri), bookmarks);
  }

  private async saveBookmark(uri: vscode.Uri, name: string, pose: Record<string, number>, camera?: PreviewState['camera']): Promise<void> {
    const trimmed = String(name ?? '').trim();
    if (!trimmed) {
      return;
    }
    const bookmarks = this.getBookmarks(uri).filter(bookmark => bookmark.name !== trimmed);
    bookmarks.push({ name: trimmed, pose: pose ?? {}, camera, createdAt: new Date().toISOString() });
    bookmarks.sort((a, b) => a.name.localeCompare(b.name));
    await this.setBookmarks(uri, bookmarks);
    void vscode.window.setStatusBarMessage(`URDF Studio bookmark "${trimmed}" saved.`, 2500);
  }

  private async deleteBookmark(uri: vscode.Uri, name: string): Promise<void> {
    const trimmed = String(name ?? '').trim();
    const bookmarks = this.getBookmarks(uri).filter(bookmark => bookmark.name !== trimmed);
    await this.setBookmarks(uri, bookmarks);
  }

  private async renameBookmark(uri: vscode.Uri, from: string, to: string): Promise<void> {
    const fromTrimmed = String(from ?? '').trim();
    const toTrimmed = String(to ?? '').trim();
    if (!fromTrimmed || !toTrimmed || fromTrimmed === toTrimmed) {
      return;
    }
    const bookmarks = this.getBookmarks(uri).map(bookmark => bookmark.name === fromTrimmed ? { ...bookmark, name: toTrimmed } : bookmark);
    await this.setBookmarks(uri, bookmarks);
  }

  private async broadcastBookmarks(preview: ActivePreview): Promise<void> {
    await preview.panel.webview.postMessage({
      type: 'bookmarksUpdated',
      bookmarks: this.getBookmarks(preview.document.uri)
    });
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

  private async saveBom(uri: vscode.Uri, csv: unknown, filenameHint: unknown): Promise<void> {
    if (typeof csv !== 'string') {
      return;
    }
    const baseName = typeof filenameHint === 'string' && filenameHint
      ? filenameHint
      : `${path.basename(uri.fsPath)}-bom.csv`;
    const defaultUri = vscode.Uri.file(path.join(path.dirname(uri.fsPath), baseName));
    const target = await vscode.window.showSaveDialog({
      title: 'Save BOM',
      defaultUri,
      filters: { CSV: ['csv'] }
    });
    if (!target) {
      return;
    }
    try {
      await vscode.workspace.fs.writeFile(target, Buffer.from(csv, 'utf8'));
      void vscode.window.showInformationMessage(`URDF Studio BOM saved: ${vscode.workspace.asRelativePath(target)}`);
    } catch (error) {
      log(`saveBom failed: ${String(error)}`);
      void vscode.window.showErrorMessage(`URDF Studio: could not write BOM (${error instanceof Error ? error.message : String(error)}).`);
    }
  }

  private async saveReport(uri: vscode.Uri, base64: unknown, filenameHint: unknown): Promise<void> {
    if (typeof base64 !== 'string' || !base64) {
      void vscode.window.showWarningMessage('URDF Studio could not build the PDF report.');
      return;
    }
    const baseName = typeof filenameHint === 'string' && filenameHint
      ? filenameHint
      : `${path.basename(uri.fsPath)}-report.pdf`;
    const defaultUri = vscode.Uri.file(path.join(path.dirname(uri.fsPath), baseName));
    const target = await vscode.window.showSaveDialog({
      title: 'Save Report',
      defaultUri,
      filters: { PDF: ['pdf'] }
    });
    if (!target) {
      return;
    }
    try {
      await vscode.workspace.fs.writeFile(target, Buffer.from(base64, 'base64'));
      void vscode.window.showInformationMessage(`URDF Studio report saved: ${vscode.workspace.asRelativePath(target)}`);
    } catch (error) {
      log(`saveReport failed: ${String(error)}`);
      void vscode.window.showErrorMessage(`URDF Studio: could not write PDF (${error instanceof Error ? error.message : String(error)}).`);
    }
  }

  private async revealRangeForLink(uri: vscode.Uri, line: unknown, _link: unknown): Promise<void> {
    if (typeof line !== 'number' || !Number.isFinite(line) || line < 1) {
      return;
    }
    // Only reveal if the user already has a text editor open for this URDF.
    // Auto-opening an editor on every link click would be far too intrusive,
    // and the URDF preview already shows the link in its own Source tab.
    const target = vscode.window.visibleTextEditors.find(editor =>
      editor.document.uri.toString() === uri.toString()
    );
    if (!target) {
      return;
    }
    try {
      const targetLine = Math.min(Math.max(0, Math.floor(line) - 1), target.document.lineCount - 1);
      const range = target.document.lineAt(targetLine).range;
      target.selection = new vscode.Selection(range.start, range.end);
      target.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
    } catch (error) {
      log(`revealRange failed: ${String(error)}`);
    }
  }

  private async writeDisableCollisions(preview: ActivePreview, entries: DisableCollisionEntry[]): Promise<void> {
    if (!Array.isArray(entries) || entries.length === 0) {
      void vscode.window.showInformationMessage('No collision pairs to write.');
      return;
    }

    let target = preview.semanticSourceFile;
    if (!target) {
      const selection = await vscode.window.showSaveDialog({
        title: 'Save SRDF',
        filters: { SRDF: ['srdf'] },
        defaultUri: vscode.Uri.file(path.join(path.dirname(preview.document.uri.fsPath), `${path.basename(preview.document.uri.fsPath, path.extname(preview.document.uri.fsPath))}.srdf`))
      });
      if (!selection) {
        return;
      }
      target = selection.fsPath;
      const robotName = preview.metadata?.robotName ?? 'robot';
      await fs.writeFile(target, `<?xml version="1.0"?>\n<robot name="${escapeXmlText(robotName)}">\n</robot>\n`, 'utf8');
    }

    let content: string;
    try {
      content = await fs.readFile(target, 'utf8');
    } catch (error) {
      void vscode.window.showErrorMessage(`Cannot read SRDF: ${String(error)}`);
      return;
    }

    const result = mergeDisableCollisionsIntoSrdf(content, entries);
    if (result.added === 0) {
      void vscode.window.showInformationMessage('All collision pairs are already disabled.');
      return;
    }
    await fs.writeFile(target, result.srdf, 'utf8');
    void vscode.window.showInformationMessage(`Wrote ${result.added} disable_collisions to ${vscode.workspace.asRelativePath(target)}.`);

    // Re-parse to refresh on the renderer.
    const parsed = parseSrdf(await fs.readFile(target, 'utf8'), target);
    void preview.panel.webview.postMessage({
      type: 'disableCollisionsUpdated',
      disableCollisions: parsed.disableCollisions
    });
  }
}

function escapeBraces(filePath: string): string {
  return filePath.replace(/[{}]/g, '\\$&');
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
    vscode.commands.registerCommand('urdfStudio.captureScreenshot', () => provider.postCommand('captureScreenshot')),
    vscode.commands.registerCommand('urdfStudio.sampleReachability', () => provider.postCommand('sampleReachability'))
  );

  registerLanguageFeatures(context);
}

export function deactivate(): void {}

function createNonce(): string {
  // Cryptographically strong nonce for CSP. 16 bytes → 32 hex chars, matching
  // the previous length while sourcing entropy from the OS instead of
  // Math.random.
  return randomBytes(16).toString('hex');
}

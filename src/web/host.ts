// Browser-side host shim. Plays the role that extension.ts plays for the VS
// Code webview: discovers packages, expands xacro, runs URDF analysis, and
// posts the `loadRobot` message to the renderer. Handles the renderer's reply
// messages (save pose, bookmark, export, screenshot, etc.).

import { discoverPackages } from '../core/packageMap';
import { renderRobotDocument } from '../core/xacro';
import { analyzeUrdf } from '../core/urdfAnalysis';
import { loadSemanticMetadata, mergeDisableCollisionsIntoSrdf, parseSrdf } from '../core/srdf';
import { escapeXmlText } from '../core/escapeXml';
import type {
  CameraSnapshot,
  DisableCollisionEntry,
  PackageMap,
  PreviewState,
  RobotMetadata,
  StudioDiagnostic
} from '../core/types';
import { requireActiveVfs } from './ioBrowser';
import { posixPath } from './vfs/posixPath';
import { getBookmarks, setBookmarks, getPreviewState, setPreviewState, getSettings } from './storage';
import type { BrowserVfs } from './vfs/types';

const VFS_URL_SCHEME = 'urdf-studio-vfs://';

interface RendererMessage {
  type: string;
  [key: string]: unknown;
}

interface RendererInbound extends RendererMessage {
  pose?: Record<string, number>;
  camera?: CameraSnapshot;
  args?: Record<string, unknown>;
  name?: string;
  from?: string;
  to?: string;
  dataUrl?: string;
  entries?: DisableCollisionEntry[];
  linkCount?: number;
  jointCount?: number;
  movableJointCount?: number;
}

export type HostStatus =
  | { type: 'idle' }
  | { type: 'info'; message: string }
  | { type: 'progress'; message: string }
  | { type: 'error'; message: string };

export interface HostToast {
  kind: 'error' | 'warning' | 'info';
  message: string;
  detail?: string;
}

export interface HostListeners {
  onStatus?(status: HostStatus): void;
  onToast?(toast: HostToast): void;
}

interface ActiveDocument {
  path: string;
  xacroArgs: Record<string, unknown>;
  metadata?: RobotMetadata;
  semanticSourceFile?: string;
  pendingState?: PreviewState;
}

export class WebHost {
  private active: ActiveDocument | undefined;
  private rendererReady = false;
  private readonly pendingRendererQueue: RendererMessage[] = [];
  private listeners: HostListeners = {};
  private readonly urlMap = new Map<string, string>();
  // Serialise loads so two rapid openDocument/reload calls cannot interleave
  // their blob-URL generation and the shared urlMap. Superseded loads are
  // skipped via the token rather than run to completion.
  private loadToken = 0;
  private loadChain: Promise<void> = Promise.resolve();

  constructor() {
    this.installRendererShim();
    window.addEventListener('message', event => {
      // Renderer→host messages arrive through the acquireVsCodeApi shim, not
      // window.postMessage; only accept window messages from our own origin so
      // a cross-origin frame cannot drive host actions (e.g. trigger downloads).
      if (event.source !== window && event.origin !== window.location.origin) {
        return;
      }
      this.handleRendererMessage(event.data as RendererInbound);
    });
  }

  setListeners(listeners: HostListeners): void {
    this.listeners = listeners;
  }

  /** Open a URDF/xacro file relative to the active VFS root. */
  async openDocument(absPath: string, options: { xacroArgs?: Record<string, unknown> } = {}): Promise<void> {
    const settings = getSettings();
    const previous = this.active;
    this.active = {
      path: absPath,
      xacroArgs: { ...settings.defaultXacroArgs, ...(options.xacroArgs ?? previous?.xacroArgs ?? {}) }
    };
    await this.loadCurrent();
  }

  async reloadWithArgs(args: Record<string, unknown>): Promise<void> {
    if (!this.active) {
      return;
    }
    const settings = getSettings();
    this.active.xacroArgs = { ...settings.defaultXacroArgs, ...args };
    await this.loadCurrent();
  }

  hasActiveDocument(): boolean {
    return this.active !== undefined;
  }

  // Queue a load behind any in-flight one. The latest enqueued load wins;
  // intermediate ones are skipped once superseded.
  private loadCurrent(overrideUrdf?: string): Promise<void> {
    const token = ++this.loadToken;
    const run = this.loadChain.then(() => {
      if (token !== this.loadToken) {
        return; // A newer load superseded this one.
      }
      return this.doLoadCurrent(overrideUrdf);
    });
    this.loadChain = run.catch(() => undefined);
    return run;
  }

  private async doLoadCurrent(overrideUrdf?: string): Promise<void> {
    if (!this.active) {
      return;
    }
    const vfs = requireActiveVfs();
    const settings = getSettings();
    const docPath = this.active.path;
    const fileName = posixPath.basename(docPath);

    try {
      this.setStatus({ type: 'progress', message: `Loading ${fileName}...` });

      const packageRoots = await this.computePackageRoots(vfs, settings.packageRoots);
      const packages = await discoverPackages(packageRoots);

      // `overrideUrdf` is a live edit from the Source pane: it is already an
      // expanded URDF, so we skip xacro expansion (and its yaml pre-warm) and
      // analyze the supplied text directly.
      let rendered: Awaited<ReturnType<typeof renderRobotDocument>>;
      if (overrideUrdf !== undefined) {
        rendered = { sourcePath: docPath, format: 'urdf', urdf: overrideUrdf, xacroArgs: [], includedFiles: [], diagnostics: [] };
      } else {
        // Pre-warm yaml cache so xacro's sync load_yaml works in the browser.
        // Scoped to the document's directory + the standard ROS subtrees of
        // every discovered package — far cheaper than slurping the whole VFS
        // on workspaces with many unrelated YAMLs.
        await this.preWarmYamlCache(docPath, vfs, packages);
        rendered = await renderRobotDocument(docPath, packages, this.active.xacroArgs);
      }
      const metadata = analyzeUrdf(rendered.urdf, docPath, packages);
      const semantic = await loadSemanticMetadata(settings.semanticFiles, packages);
      const diagnostics: StudioDiagnostic[] = [
        ...rendered.diagnostics,
        ...metadata.diagnostics,
        ...semantic.diagnostics
      ];

      this.active.metadata = metadata;
      this.active.semanticSourceFile = semantic.sourceFile;

      // Open a new blob-URL generation. The prior generation stays alive until
      // the renderer signals geometryLoaded, so any in-flight asset fetches
      // started against the previous robot can still complete.
      vfs.beginGeneration();
      this.urlMap.clear();
      await this.preallocateMeshUrls(metadata, vfs);

      const sourceBaseUri = this.toBaseUri(posixPath.dirname(docPath));
      const packageMap = this.buildPackageUriMap(packages);

      const savedState = this.active.pendingState ?? getPreviewState(this.documentKey(docPath));
      this.active.pendingState = undefined;
      const bookmarks = getBookmarks(this.documentKey(docPath));

      this.postToRenderer({
        type: 'loadRobot',
        documentUri: this.documentKey(docPath),
        fileName,
        sourcePath: docPath,
        sourceBaseUri,
        format: rendered.format,
        urdf: rendered.urdf,
        packageMap,
        metadata,
        semantic,
        diagnostics,
        xacroArgs: rendered.xacroArgs,
        xacroArgValues: this.active.xacroArgs,
        renderSettings: {
          renderMode: settings.defaultRenderMode,
          upAxis: settings.upAxis
        },
        savedState,
        bookmarks,
        // Custom field that the renderer's URL modifier consumes — used to
        // translate `urdf-studio-vfs:///...` URLs into blob URLs at load time.
        vfsUrlMap: Object.fromEntries(this.urlMap),
        vfsUrlScheme: VFS_URL_SCHEME
      });

      this.setStatus({
        type: 'info',
        message: `${metadata.robotName}: ${metadata.counts.links} links, ${metadata.counts.movableJoints} movable.`
      });

      // Surface diagnostics through the toast layer so the user notices
      // parse problems immediately. Errors are sticky; warnings auto-dismiss.
      this.reportDiagnostics(diagnostics, fileName);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[urdf] load failed', error);
      this.setStatus({ type: 'error', message: `Load failed: ${message}` });
      this.emitToast({
        kind: 'error',
        message: `Failed to load ${fileName}`,
        detail: message
      });
    }
  }

  /** Group diagnostics by severity and emit a toast per group. The message
   *  is a count; the detail lists the first few entries verbatim. */
  private reportDiagnostics(diagnostics: StudioDiagnostic[], fileName: string): void {
    const errors = diagnostics.filter(d => d.severity === 'error');
    const warnings = diagnostics.filter(d => d.severity === 'warning');
    const previewLines = (items: StudioDiagnostic[]) =>
      items.slice(0, 3).map(d => `• ${d.message}`).join('\n') +
      (items.length > 3 ? `\n• …and ${items.length - 3} more (see Checks tab)` : '');

    if (errors.length > 0) {
      this.emitToast({
        kind: 'error',
        message: `${errors.length} error${errors.length === 1 ? '' : 's'} in ${fileName}`,
        detail: previewLines(errors)
      });
    }
    if (warnings.length > 0) {
      this.emitToast({
        kind: 'warning',
        message: `${warnings.length} warning${warnings.length === 1 ? '' : 's'} in ${fileName}`,
        detail: previewLines(warnings)
      });
    }
  }

  private emitToast(toast: HostToast): void {
    this.listeners.onToast?.(toast);
  }

  private installRendererShim(): void {
    const host = this;
    // The renderer calls acquireVsCodeApi() to get a postMessage handle. We
    // intercept here so renderer messages flow back to us, and host -> renderer
    // messages use window.postMessage (same-origin dispatches a MessageEvent).
    (globalThis as unknown as { acquireVsCodeApi: () => unknown }).acquireVsCodeApi = () => ({
      postMessage(message: RendererInbound) {
        // Defer so the renderer's call site finishes synchronously first.
        queueMicrotask(() => host.handleRendererMessage(message));
      },
      setState() {
        /* no-op */
      },
      getState() {
        return null;
      }
    });
  }

  private async handleRendererMessage(message: RendererInbound | undefined): Promise<void> {
    if (!message || typeof message.type !== 'string') {
      return;
    }
    switch (message.type) {
      case 'ready':
        this.rendererReady = true;
        while (this.pendingRendererQueue.length > 0) {
          window.postMessage(this.pendingRendererQueue.shift()!, window.location.origin);
        }
        break;
      case 'reloadWithXacroArgs':
        await this.reloadWithArgs((message.args as Record<string, unknown>) ?? {});
        break;
      case 'requestSavePose':
        if (this.active) {
          setPreviewState(this.documentKey(this.active.path), {
            pose: message.pose,
            camera: message.camera
          });
          this.setStatus({ type: 'info', message: 'Pose saved.' });
        }
        break;
      case 'requestSaveBookmark':
        if (this.active && typeof message.name === 'string') {
          this.upsertBookmark(message.name, message.pose ?? {}, message.camera);
        }
        break;
      case 'requestDeleteBookmark':
        if (this.active && typeof message.name === 'string') {
          this.deleteBookmark(message.name);
        }
        break;
      case 'requestRenameBookmark':
        if (this.active && typeof message.from === 'string' && typeof message.to === 'string') {
          this.renameBookmark(message.from, message.to);
        }
        break;
      case 'exportPoseResult':
        this.downloadPose(message.pose ?? {}, message.camera);
        break;
      case 'screenshotResult':
        if (typeof message.dataUrl === 'string') {
          this.downloadScreenshot(message.dataUrl);
        }
        break;
      case 'requestSaveBom':
        if (typeof message.csv === 'string') {
          this.downloadBom(message.csv, typeof message.filename === 'string' ? message.filename : undefined);
        }
        break;
      case 'requestSaveReport':
        if (typeof message.base64 === 'string') {
          this.downloadReport(message.base64, typeof message.filename === 'string' ? message.filename : undefined);
        }
        break;
      case 'requestRevealRange':
        // Browser shell has its own Source tab; no separate editor to reveal.
        break;
      case 'previewEdit':
        if (this.active && typeof message.text === 'string') {
          await this.loadCurrent(message.text);
        }
        break;
      case 'requestSaveSource':
        if (this.active && typeof message.text === 'string') {
          this.downloadSource(message.text);
        }
        break;
      case 'requestWriteDisableCollisions':
        await this.handleWriteDisableCollisions(message.entries ?? []);
        break;
      case 'geometryLoaded':
        // The renderer has finished consuming the meshes from the in-flight
        // load (manager.onLoad waits for every queued asset). Safe to revoke
        // the previous-generation blob URLs now.
        try {
          requireActiveVfs().commitGeneration();
        } catch {
          // VFS may have been swapped before this ack arrived; ignore.
        }
        this.setStatus({
          type: 'info',
          message: `Geometry ready: ${message.linkCount ?? 0} links, ${message.jointCount ?? 0} joints, ${message.movableJointCount ?? 0} movable.`
        });
        break;
      case 'poseSnapshot':
        if (this.active) {
          this.active.pendingState = { pose: message.pose, camera: message.camera };
          void this.loadCurrent();
        }
        break;
      default:
        break;
    }
  }

  private postToRenderer(message: RendererMessage): void {
    if (!this.rendererReady) {
      this.pendingRendererQueue.push(message);
      return;
    }
    // Target our own origin so the renderer's origin check accepts it and the
    // message can't be observed by a cross-origin frame.
    window.postMessage(message, window.location.origin);
  }

  private setStatus(status: HostStatus): void {
    this.listeners.onStatus?.(status);
  }

  private upsertBookmark(name: string, pose: Record<string, number>, camera?: CameraSnapshot): void {
    if (!this.active) {
      return;
    }
    const trimmed = name.trim();
    if (!trimmed) {
      return;
    }
    const key = this.documentKey(this.active.path);
    const bookmarks = getBookmarks(key).filter(item => item.name !== trimmed);
    bookmarks.push({ name: trimmed, pose, camera, createdAt: new Date().toISOString() });
    bookmarks.sort((a, b) => a.name.localeCompare(b.name));
    setBookmarks(key, bookmarks);
    this.broadcastBookmarks();
    this.setStatus({ type: 'info', message: `Bookmark "${trimmed}" saved.` });
  }

  private deleteBookmark(name: string): void {
    if (!this.active) {
      return;
    }
    const key = this.documentKey(this.active.path);
    const next = getBookmarks(key).filter(item => item.name !== name);
    setBookmarks(key, next);
    this.broadcastBookmarks();
  }

  private renameBookmark(from: string, to: string): void {
    if (!this.active) {
      return;
    }
    const key = this.documentKey(this.active.path);
    const trimmedTo = to.trim();
    if (!trimmedTo || from === trimmedTo) {
      return;
    }
    const next = getBookmarks(key).map(item => item.name === from ? { ...item, name: trimmedTo } : item);
    setBookmarks(key, next);
    this.broadcastBookmarks();
  }

  private broadcastBookmarks(): void {
    if (!this.active) {
      return;
    }
    this.postToRenderer({
      type: 'bookmarksUpdated',
      bookmarks: getBookmarks(this.documentKey(this.active.path))
    });
  }

  private downloadPose(pose: unknown, camera: unknown): void {
    if (!this.active) {
      return;
    }
    const payload = {
      source: this.active.path,
      exportedAt: new Date().toISOString(),
      pose,
      camera
    };
    triggerDownload(
      new Blob([`${JSON.stringify(payload, null, 2)}\n`], { type: 'application/json' }),
      `${posixPath.basename(this.active.path)}-pose.json`
    );
  }

  private downloadScreenshot(dataUrl: string): void {
    if (!this.active) {
      return;
    }
    if (!dataUrl.startsWith('data:image/png;base64,')) {
      this.setStatus({ type: 'error', message: 'Screenshot failed.' });
      return;
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const filename = `${posixPath.basename(this.active.path)}-${stamp}.png`;
    const link = document.createElement('a');
    link.href = dataUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }

  private downloadBom(csv: string, filename?: string): void {
    if (!this.active) {
      return;
    }
    const name = filename || `${posixPath.basename(this.active.path)}-bom.csv`;
    triggerDownload(new Blob([csv], { type: 'text/csv' }), name);
    this.setStatus({ type: 'info', message: `BOM downloaded: ${name}` });
  }

  private downloadSource(text: string): void {
    if (!this.active) {
      return;
    }
    const name = posixPath.basename(this.active.path) || 'robot.urdf';
    triggerDownload(new Blob([text], { type: 'application/xml' }), name);
    this.setStatus({ type: 'info', message: `Source downloaded: ${name}` });
  }

  private downloadReport(base64: string, filename?: string): void {
    if (!this.active) {
      return;
    }
    const name = filename || `${posixPath.basename(this.active.path)}-report.pdf`;
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) {
      bytes[i] = binary.charCodeAt(i);
    }
    triggerDownload(new Blob([bytes], { type: 'application/pdf' }), name);
    this.setStatus({ type: 'info', message: `Report downloaded: ${name}` });
  }

  private async handleWriteDisableCollisions(entries: DisableCollisionEntry[]): Promise<void> {
    if (!this.active || entries.length === 0) {
      this.setStatus({ type: 'info', message: 'No collision pairs to write.' });
      return;
    }
    const vfs = requireActiveVfs();
    let content: string;
    let outputFile = this.active.semanticSourceFile;
    if (outputFile) {
      try {
        content = await vfs.readText(outputFile);
      } catch (error) {
        this.setStatus({ type: 'error', message: `Cannot read SRDF: ${String(error)}` });
        return;
      }
    } else {
      const robotName = this.active.metadata?.robotName ?? 'robot';
      content = `<?xml version="1.0"?>\n<robot name="${escapeXmlText(robotName)}">\n</robot>\n`;
      const docDir = posixPath.dirname(this.active.path);
      const baseName = posixPath.basename(this.active.path).replace(/\.(urdf|xacro|urdf\.xacro)$/i, '');
      outputFile = posixPath.join(docDir, `${baseName}.srdf`);
    }
    const merged = mergeDisableCollisionsIntoSrdf(content, entries);
    if (merged.added === 0) {
      this.setStatus({ type: 'info', message: 'All collision pairs already disabled.' });
      return;
    }
    triggerDownload(
      new Blob([merged.srdf], { type: 'application/xml' }),
      posixPath.basename(outputFile)
    );
    const parsed = parseSrdf(merged.srdf, outputFile);
    this.postToRenderer({
      type: 'disableCollisionsUpdated',
      disableCollisions: parsed.disableCollisions
    });
    this.setStatus({ type: 'info', message: `Wrote ${merged.added} disable_collisions. SRDF downloaded.` });
  }

  private documentKey(absPath: string): string {
    const vfs = requireActiveVfs();
    // Compose with a separator and use the path relative to the VFS root so a
    // folder named `franka_description` always produces the same key, no
    // matter which parent directory the user opened it from. See
    // computeDocumentKey() for the pure helper used by tests.
    return computeDocumentKey(vfs.label, vfs.root, absPath);
  }

  private async computePackageRoots(vfs: BrowserVfs, extraRoots: string[]): Promise<string[]> {
    const roots = new Set<string>([vfs.root]);
    for (const root of extraRoots) {
      if (root) {
        roots.add(posixPath.isAbsolute(root) ? root : posixPath.join(vfs.root, root));
      }
    }
    return Array.from(roots);
  }

  /** Pre-load YAML files xacro's synchronous load_yaml() might want.
   *  Rather than blindly slurping every YAML in the VFS (which on a ROS
   *  workspace with hundreds of unrelated launch/config YAMLs is wasteful),
   *  we scope to:
   *    1. The directory the URDF/xacro lives in.
   *    2. The "config" and "urdf" siblings of that directory (standard ROS
   *       layout — package_name/{config,urdf}/...).
   *    3. Equivalent subdirectories of every discovered package's root.
   *  If xacro later issues a load_yaml() for a YAML outside this scope,
   *  the readTextSync() call will throw a clear "miss" error and the
   *  diagnostic surfaces in the Checks panel — far better feedback than a
   *  silent full-tree scan. */
  private async preWarmYamlCache(sourcePath: string, vfs: BrowserVfs, packages: PackageMap = {}): Promise<void> {
    const candidates = computeYamlPreWarmSet(sourcePath, vfs.allFiles(), packages);
    if (candidates.length === 0) {
      return;
    }
    await vfs.warmTextCache(candidates);
  }

  /** Build a synchronous urdf-studio-vfs:// → blob: URL map for every mesh file
   *  the URDF references. The renderer installs this as a LoadingManager URL
   *  modifier. */
  private async preallocateMeshUrls(metadata: RobotMetadata, vfs: BrowserVfs): Promise<void> {
    const pending: Promise<void>[] = [];
    for (const mesh of metadata.meshes) {
      if (!mesh.exists || !mesh.resolvedPath) {
        continue;
      }
      const vfsUrl = this.toFileUri(mesh.resolvedPath);
      if (this.urlMap.has(vfsUrl)) {
        continue;
      }
      pending.push(vfs.getBlobUrl(mesh.resolvedPath).then(blob => {
        this.urlMap.set(vfsUrl, blob);
      }).catch(error => {
        console.warn('[urdf] could not pre-allocate mesh URL for', mesh.resolvedPath, error);
      }));
    }
    await Promise.all(pending);

    // For Collada meshes, peek inside to find external texture references so
    // they too can be served as blob URLs.
    await this.preallocateColladaTextures(metadata, vfs);
    await this.preallocateGltfAssets(metadata, vfs);
  }

  private async preallocateColladaTextures(metadata: RobotMetadata, vfs: BrowserVfs): Promise<void> {
    const daePaths = metadata.meshes
      .filter(mesh => mesh.exists && mesh.resolvedPath?.toLowerCase().endsWith('.dae'))
      .map(mesh => mesh.resolvedPath!) as string[];
    if (daePaths.length === 0) {
      return;
    }
    const initFromRegex = /<init_from>\s*([^<\s]+)\s*<\/init_from>/g;
    const imageRefRegex = /<image[^>]*\s+(?:source|url)="([^"]+)"/g;

    const pending: Promise<void>[] = [];
    for (const daePath of daePaths) {
      try {
        const text = await vfs.readText(daePath);
        const baseDir = posixPath.dirname(daePath);
        const refs = new Set<string>();
        let m: RegExpExecArray | null;
        while ((m = initFromRegex.exec(text)) !== null) {
          refs.add(m[1].trim());
        }
        initFromRegex.lastIndex = 0;
        while ((m = imageRefRegex.exec(text)) !== null) {
          refs.add(m[1].trim());
        }
        imageRefRegex.lastIndex = 0;
        for (const ref of refs) {
          if (/^[a-zA-Z]+:\/\//.test(ref)) {
            continue;
          }
          const abs = ref.startsWith('/') ? ref : posixPath.resolve(baseDir, ref);
          if (!vfs.existsSync(abs)) {
            continue;
          }
          const vfsUrl = this.toFileUri(abs);
          if (this.urlMap.has(vfsUrl)) {
            continue;
          }
          pending.push(vfs.getBlobUrl(abs).then(blob => {
            this.urlMap.set(vfsUrl, blob);
          }).catch(error => {
            console.warn('[urdf] could not pre-allocate collada texture URL for', abs, error);
          }));
        }
      } catch (error) {
        // Collada files can ship corrupted on real robots; surface to console
        // so the user has something to grep but don't block the URDF load.
        console.warn('[urdf] preallocateColladaTextures: could not inspect', daePath, error);
      }
    }
    await Promise.all(pending);
  }

  private async preallocateGltfAssets(metadata: RobotMetadata, vfs: BrowserVfs): Promise<void> {
    const gltfPaths = metadata.meshes
      .filter(mesh => mesh.exists && mesh.resolvedPath?.toLowerCase().endsWith('.gltf'))
      .map(mesh => mesh.resolvedPath!) as string[];
    if (gltfPaths.length === 0) {
      return;
    }
    const pending: Promise<void>[] = [];
    for (const gltfPath of gltfPaths) {
      try {
        const text = await vfs.readText(gltfPath);
        const json = JSON.parse(text) as { buffers?: Array<{ uri?: string }>; images?: Array<{ uri?: string }> };
        const baseDir = posixPath.dirname(gltfPath);
        const refs: string[] = [];
        for (const buffer of json.buffers ?? []) {
          if (buffer.uri && !buffer.uri.startsWith('data:')) {
            refs.push(buffer.uri);
          }
        }
        for (const image of json.images ?? []) {
          if (image.uri && !image.uri.startsWith('data:')) {
            refs.push(image.uri);
          }
        }
        for (const ref of refs) {
          const abs = ref.startsWith('/') ? ref : posixPath.resolve(baseDir, ref);
          if (!vfs.existsSync(abs)) {
            continue;
          }
          const vfsUrl = this.toFileUri(abs);
          if (this.urlMap.has(vfsUrl)) {
            continue;
          }
          pending.push(vfs.getBlobUrl(abs).then(blob => {
            this.urlMap.set(vfsUrl, blob);
          }).catch(error => {
            console.warn('[urdf] could not pre-allocate gltf asset URL for', abs, error);
          }));
        }
      } catch (error) {
        // Malformed gltf json — surface and continue.
        console.warn('[urdf] preallocateGltfAssets: could not inspect', gltfPath, error);
      }
    }
    await Promise.all(pending);
  }

  /** workingPath URI — URDFLoader concatenates a relative path directly onto
   *  this, so it MUST have a trailing slash. */
  private toBaseUri(directoryPath: string): string {
    return `${VFS_URL_SCHEME}${ensureLeadingSlash(directoryPath)}/`.replace(/\/+$/, '/');
  }

  /** packageMap entry — URDFLoader builds the final URL with
   *  `packages[pkg] + '/' + relPath`, so this MUST NOT have a trailing slash
   *  or every fetch URL gets a leading double slash and breaks the URL
   *  modifier lookup. */
  private toPackageRootUri(directoryPath: string): string {
    return `${VFS_URL_SCHEME}${ensureLeadingSlash(directoryPath)}`.replace(/\/+$/, '');
  }

  private toFileUri(filePath: string): string {
    return `${VFS_URL_SCHEME}${ensureLeadingSlash(filePath)}`;
  }

  private buildPackageUriMap(packages: PackageMap): Record<string, string> {
    return Object.fromEntries(
      Object.entries(packages).map(([name, entry]) => [name, this.toPackageRootUri(entry.path)])
    );
  }
}

function ensureLeadingSlash(p: string): string {
  return p.startsWith('/') ? p : `/${p}`;
}

// Pure helper exported for unit testing. Builds a stable identifier for a
// document inside a VFS that combines:
//   - the VFS label (the root folder's basename)
//   - the path of the document relative to the VFS root
// We use a `::` separator so two different paths cannot collide with each
// other through string concatenation (e.g. label `franka_description` with
// path `/foo/bar` no longer accidentally matches label `franka` with path
// `_description/foo/bar`).
export function computeDocumentKey(label: string, root: string, absPath: string): string {
  let relative = absPath;
  if (root && absPath.startsWith(root)) {
    relative = absPath.slice(root.length) || '/';
    if (!relative.startsWith('/')) {
      relative = `/${relative}`;
    }
  }
  return `${label}::${relative}`;
}

/**
 * Compute the YAML file paths to pre-warm before xacro expansion.
 *
 * Strategy: only scope to paths a typical ROS package would put on its
 * load_yaml() resolution path, NOT every YAML in the workspace. We include:
 *   - the document's own directory
 *   - the document's `../config/` and `../urdf/` siblings
 *   - each discovered package's root + its `config/` and `urdf/` subtrees
 * and any path matching one of those prefixes.
 *
 * Exported as a pure function so the scoping logic is unit-testable
 * without a live VFS.
 */
export function computeYamlPreWarmSet(
  docPath: string,
  allPaths: ReadonlyArray<string>,
  packages: PackageMap
): string[] {
  const yamlPaths = allPaths.filter(p => /\.(ya?ml)$/i.test(p));
  if (yamlPaths.length === 0) {
    return [];
  }

  const docDir = posixPath.dirname(docPath);
  const docParent = posixPath.dirname(docDir);

  // Build the prefix whitelist. Each entry is treated as "this directory and
  // anything underneath".
  const prefixes = new Set<string>();
  prefixes.add(`${docDir}/`);
  prefixes.add(`${docParent}/config/`);
  prefixes.add(`${docParent}/urdf/`);
  for (const pkg of Object.values(packages)) {
    const root = pkg.path.replace(/\/+$/, '');
    prefixes.add(`${root}/`);
    prefixes.add(`${root}/config/`);
    prefixes.add(`${root}/urdf/`);
  }

  // Deduplicate + keep stable iteration order.
  return yamlPaths.filter(p => {
    for (const prefix of prefixes) {
      if (p === prefix.slice(0, -1) || p.startsWith(prefix)) {
        return true;
      }
    }
    return false;
  });
}

function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Give the browser a tick to start the download before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

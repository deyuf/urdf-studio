// Browser-side host shim. Plays the role that extension.ts plays for the VS
// Code webview: discovers packages, expands xacro, runs URDF analysis, and
// posts the `loadRobot` message to the renderer. Handles the renderer's reply
// messages (save pose, bookmark, export, screenshot, etc.).

import { discoverPackages } from '../core/packageMap';
import { renderRobotDocument, setLogger } from '../core/xacro';
import { analyzeUrdf } from '../core/urdfAnalysis';
import { loadSemanticMetadata, mergeDisableCollisionsIntoSrdf, parseSrdf } from '../core/srdf';
import type {
  CameraSnapshot,
  DisableCollisionEntry,
  PackageMap,
  PoseBookmark,
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

export interface HostListeners {
  onStatus?(status: HostStatus): void;
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

  constructor() {
    setLogger(message => console.debug('[urdf]', message));
    this.installRendererShim();
    window.addEventListener('message', event => {
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

  private async loadCurrent(): Promise<void> {
    if (!this.active) {
      return;
    }
    const vfs = requireActiveVfs();
    const settings = getSettings();
    const docPath = this.active.path;
    const fileName = posixPath.basename(docPath);

    try {
      this.setStatus({ type: 'progress', message: `Loading ${fileName}...` });

      // Pre-warm yaml cache so xacro's sync load_yaml works in the browser.
      await this.preWarmYamlCache(docPath, vfs);

      const packageRoots = await this.computePackageRoots(vfs, settings.packageRoots);
      const packages = await discoverPackages(packageRoots);

      const rendered = await renderRobotDocument(docPath, packages, this.active.xacroArgs);
      const metadata = analyzeUrdf(rendered.urdf, docPath, packages);
      const semantic = await loadSemanticMetadata(settings.semanticFiles, packages);
      const diagnostics: StudioDiagnostic[] = [
        ...rendered.diagnostics,
        ...metadata.diagnostics,
        ...semantic.diagnostics
      ];

      this.active.metadata = metadata;
      this.active.semanticSourceFile = semantic.sourceFile;

      // Free any blob URLs from the previous robot then mint fresh ones for the
      // meshes this robot needs.
      vfs.releaseBlobs();
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
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error('[urdf] load failed', error);
      this.setStatus({ type: 'error', message: `Load failed: ${message}` });
    }
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
          window.postMessage(this.pendingRendererQueue.shift()!, '*');
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
      case 'requestWriteDisableCollisions':
        await this.handleWriteDisableCollisions(message.entries ?? []);
        break;
      case 'geometryLoaded':
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
    window.postMessage(message, '*');
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
    return `${vfs.label}${absPath}`;
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

  /** Pre-load every YAML in the VFS so xacro's synchronous load_yaml()
   *  expression can read from cache. YAML files are tiny relative to meshes;
   *  caching them up front is much simpler and more reliable than trying to
   *  trace indirect xacro property references. */
  private async preWarmYamlCache(_sourcePath: string, vfs: BrowserVfs): Promise<void> {
    const yamlPaths = vfs.allFiles().filter(path => /\.(ya?ml)$/i.test(path));
    if (yamlPaths.length === 0) {
      return;
    }
    await vfs.warmTextCache(yamlPaths);
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
          }).catch(() => undefined));
        }
      } catch {
        // best-effort
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
          }).catch(() => undefined));
        }
      } catch {
        // best-effort
      }
    }
    await Promise.all(pending);
  }

  private toBaseUri(directoryPath: string): string {
    return `${VFS_URL_SCHEME}${ensureLeadingSlash(directoryPath)}/`.replace(/\/+$/, '/');
  }

  private toFileUri(filePath: string): string {
    return `${VFS_URL_SCHEME}${ensureLeadingSlash(filePath)}`;
  }

  private buildPackageUriMap(packages: PackageMap): Record<string, string> {
    return Object.fromEntries(
      Object.entries(packages).map(([name, entry]) => [name, this.toBaseUri(entry.path)])
    );
  }
}

function ensureLeadingSlash(p: string): string {
  return p.startsWith('/') ? p : `/${p}`;
}

function escapeXmlText(value: string): string {
  return value.replace(/[&<>"]/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;'
  }[char] as string));
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

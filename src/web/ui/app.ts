// Top-level browser UI: directory picker, file selector, status bar, settings.

import { DirectoryHandleVfs } from '../vfs/directoryHandle';
import { FileListVfs } from '../vfs/fileList';
import { setActiveVfs } from '../ioBrowser';
import { getSettings, saveSettings, type UserSettings } from '../storage';
import {
  canPersistHandles,
  clearStoredDirectoryHandle,
  getStoredDirectoryHandle,
  setStoredDirectoryHandle
} from '../handleStore';
import type { BrowserVfs } from '../vfs/types';
import type { WebHost, HostStatus } from '../host';
import { mountOnboarding, shouldShowOnboarding } from './onboarding';
import { mountToast } from './toast';
import { mountThemeSwitcher } from './theme';
import { icon } from './icons';
import { isMjcfContent } from '../../core/mjcf';

const URDF_PATTERNS = /\.(urdf|xacro|urdf\.xacro|mjcf)$/i;
// MuJoCo models are usually plain .xml; these are checked for a <mujoco>
// root. ROS manifests and launch files are never robot descriptions.
const XML_CANDIDATE = /\.xml$/i;
const NOT_A_MODEL = /(^|\/)(package|manifest|.*\.launch|.*_launch)\.xml$/i;
const MAX_XML_PROBES = 500;

declare global {
  interface Window {
    showDirectoryPicker?: (options?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
  }
}

// The File System Access permission API isn't in the default TS DOM lib yet.
type PermissionDescriptor = { mode?: 'read' | 'readwrite' };
type PermissionableHandle = FileSystemDirectoryHandle & {
  queryPermission?(descriptor?: PermissionDescriptor): Promise<PermissionState>;
  requestPermission?(descriptor?: PermissionDescriptor): Promise<PermissionState>;
};

export class AppShell {
  private vfs: BrowserVfs | null = null;
  private currentFile: string | null = null;
  // Monotonic token guarding folder-open races: opening folder A then B must
  // let B win even if A's scan finishes later (latest-should-win).
  private openToken = 0;
  // AbortController for the in-flight directory scan, so starting a new open
  // cancels the previous one.
  private activeScan: AbortController | null = null;
  private readonly onboarding = mountOnboarding();
  private readonly toast = mountToast();
  private emptyState: HTMLElement | null = null;
  private candidates: string[] = [];
  private reopenHandle: FileSystemDirectoryHandle | null = null;

  constructor(private readonly host: WebHost) {
    this.render();
    this.host.setListeners({
      onStatus: status => this.renderStatus(status),
      onToast: toast => this.toast.push(toast)
    });
    if (shouldShowOnboarding()) {
      // Defer to the next frame so the topbar finishes laying out first.
      requestAnimationFrame(() => this.onboarding.open());
    }
    // Offer to reopen the last folder if one was persisted. Fire-and-forget;
    // surfaces a button in the topbar when a stored handle is found.
    void this.maybeOfferReopen();
  }

  private render(): void {
    const topbar = document.getElementById('topbar');
    if (!topbar) {
      return;
    }
    topbar.innerHTML = `
      <div class="topbar-row">
        <div class="brand">
          <img src="./icon.png" alt="" class="brand-icon" width="22" height="22">
          <span class="brand-name">URDF Studio</span>
        </div>
        <div class="topbar-source" role="group" aria-label="Robot source">
          <button id="open-directory" class="tb-btn" aria-label="Open folder" title="Open a ROS package or workspace folder">${icon('folder', { size: 16 })}<span>Open folder</span></button>
          <button id="reopen-directory" class="tb-btn ghost" title="Reopen the last folder you used" hidden></button>
          <button id="open-files" class="tb-btn ghost" title="Select files when your browser has no folder picker">Pick files</button>
          <span class="topbar-divider" aria-hidden="true"></span>
          <label class="file-picker">
            <span class="visually-hidden">Robot file</span>
            ${icon('description', { size: 16, className: 'file-picker-icon' })}
            <select id="file-select" disabled>
              <option value="">No folder loaded</option>
            </select>
          </label>
        </div>
        <div class="topbar-actions">
          <a id="docs-link" class="tb-btn ghost" href="./docs/" title="Open the documentation in a new tab" target="_blank" rel="noopener">Docs${icon('arrow_outward', { size: 14 })}</a>
          <div id="theme-mount" class="theme-mount"></div>
          <button id="help-btn" class="tb-btn ghost icon-btn" aria-label="Show onboarding tour" title="Show the onboarding tour">${icon('help', { size: 18 })}</button>
          <details id="settings-menu" class="workbench-menu settings-menu">
            <summary id="settings-btn" class="tb-btn ghost icon-btn" aria-label="Settings" title="Settings">${icon('settings', { size: 18 })}</summary>
            <div class="menu-content settings-options">
              <span class="menu-heading">Appearance</span>
              <div id="palette-settings-mount"></div>
              <button id="model-settings-btn" type="button">Model settings…</button>
            </div>
          </details>
        </div>
      </div>
      <input id="file-input" type="file" webkitdirectory multiple hidden>
      <dialog id="settings-dialog">
        <form method="dialog" id="settings-form">
          <h3>Settings</h3>
          <label>
            Default render mode
            <select name="defaultRenderMode">
              <option value="visual">Visual</option>
              <option value="collision">Collision</option>
              <option value="both">Both</option>
            </select>
          </label>
          <label>
            Up axis
            <select name="upAxis">
              <option value="+X">+X</option>
              <option value="+Y">+Y</option>
              <option value="+Z">+Z</option>
            </select>
          </label>
          <label>
            Default xacro args (JSON object)
            <textarea name="defaultXacroArgs" rows="4" spellcheck="false"></textarea>
          </label>
          <label>
            Extra package roots (one per line, absolute or relative to folder root)
            <textarea name="packageRoots" rows="3" spellcheck="false"></textarea>
          </label>
          <label>
            Semantic files (SRDF/YAML, one per line)
            <textarea name="semanticFiles" rows="3" spellcheck="false"></textarea>
          </label>
          <div class="dialog-actions">
            <button value="cancel" formnovalidate>Cancel</button>
            <button value="save" id="settings-save" class="primary">Save</button>
          </div>
        </form>
      </dialog>
    `;

    const openBtn = document.getElementById('open-directory') as HTMLButtonElement;
    const fileBtn = document.getElementById('open-files') as HTMLButtonElement;
    const fileInput = document.getElementById('file-input') as HTMLInputElement;
    const fileSelect = document.getElementById('file-select') as HTMLSelectElement;
    const settingsBtn = document.getElementById('model-settings-btn') as HTMLButtonElement;
    const helpBtn = document.getElementById('help-btn') as HTMLButtonElement;

    if (!window.showDirectoryPicker) {
      openBtn.disabled = true;
      openBtn.title = 'Folder picker not supported by this browser — use Pick Files';
    }

    openBtn.addEventListener('click', () => void this.handleOpenDirectory());
    fileBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      if (fileInput.files && fileInput.files.length > 0) {
        void this.handleFileList(fileInput.files);
        fileInput.value = '';
      }
    });
    fileSelect.addEventListener('change', () => {
      if (fileSelect.value) {
        this.currentFile = fileSelect.value;
        this.renderEmptyState();
        void this.host.openDocument(fileSelect.value);
      }
    });
    settingsBtn.addEventListener('click', () => {
      (document.getElementById('settings-menu') as HTMLDetailsElement).open = false;
      this.openSettings();
    });
    helpBtn.addEventListener('click', () => this.onboarding.open());

    const themeMount = document.getElementById('theme-mount') as HTMLElement;
    mountThemeSwitcher(themeMount);
    this.mountStatus();
  }

  /** The status line lives in the bottom bar, so progress and info
   *  messages never push the workspace down while a model loads. */
  private mountStatus(): void {
    const node = document.createElement('div');
    node.id = 'topbar-status';
    node.className = 'status-text';
    node.hidden = true;
    node.setAttribute('role', 'status');
    node.setAttribute('aria-live', 'polite');
    const footer = document.querySelector('.project-footer');
    (footer ?? document.getElementById('topbar'))?.prepend(node);
  }

  /** Mount the viewport's empty state. Called once the renderer has built
   *  its DOM, because the overlay lives inside `.viewport-wrap`. */
  mountEmptyState(): void {
    const wrap = document.querySelector<HTMLElement>('.viewport-wrap');
    if (!wrap || this.emptyState) {
      return;
    }
    const node = document.createElement('div');
    node.id = 'empty-state';
    node.className = 'empty-state';
    wrap.appendChild(node);
    this.emptyState = node;
    node.addEventListener('click', event => {
      const target = (event.target as HTMLElement).closest<HTMLElement>('[data-empty-action]');
      if (!target) {
        return;
      }
      const action = target.dataset.emptyAction;
      if (action === 'open-folder') {
        void this.handleOpenDirectory();
      } else if (action === 'pick-files') {
        (document.getElementById('file-input') as HTMLInputElement).click();
      } else if (action === 'reopen' && this.reopenHandle) {
        const button = document.getElementById('reopen-directory') as HTMLButtonElement;
        void this.reopenStoredHandle(this.reopenHandle, button);
      } else if (action === 'open-file' && target.dataset.path) {
        this.openCandidate(target.dataset.path);
      }
    });

    // Folders can be dropped straight onto the viewport (Chromium exposes
    // directory handles on drop; other browsers fall back to the buttons).
    wrap.addEventListener('dragover', event => {
      if (event.dataTransfer?.types.includes('Files')) {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'copy';
        wrap.classList.add('drop-target');
      }
    });
    wrap.addEventListener('dragleave', event => {
      if (!wrap.contains(event.relatedTarget as Node | null)) {
        wrap.classList.remove('drop-target');
      }
    });
    wrap.addEventListener('drop', event => {
      wrap.classList.remove('drop-target');
      void this.handleDrop(event);
    });
    this.renderEmptyState();
  }

  private async handleDrop(event: DragEvent): Promise<void> {
    const items = Array.from(event.dataTransfer?.items ?? []).filter(item => item.kind === 'file');
    if (items.length === 0) {
      return;
    }
    event.preventDefault();
    // getAsFileSystemHandle must be called synchronously inside the drop
    // event; the DataTransfer is neutered after the first await.
    const item = items[0] as DataTransferItem & { getAsFileSystemHandle?: () => Promise<FileSystemHandle | null> };
    const pending = typeof item.getAsFileSystemHandle === 'function' ? item.getAsFileSystemHandle() : null;
    const handle = pending ? await pending.catch(() => null) : null;
    if (handle && handle.kind === 'directory') {
      const directory = handle as FileSystemDirectoryHandle;
      void setStoredDirectoryHandle(directory).catch(() => undefined);
      await this.scanHandle(directory);
      return;
    }
    this.toast.push({
      kind: 'info',
      message: 'Drop a folder, not a single file',
      detail: 'Meshes and included xacro files are resolved relative to the package folder. Use Open folder or Pick files if your browser does not support folder drops.'
    });
  }

  private openCandidate(path: string): void {
    const select = document.getElementById('file-select') as HTMLSelectElement;
    select.value = path;
    this.currentFile = path;
    this.renderEmptyState();
    void this.host.openDocument(path);
  }

  private renderEmptyState(): void {
    const node = this.emptyState;
    if (!node) {
      return;
    }
    if (this.currentFile) {
      node.hidden = true;
      node.replaceChildren();
      return;
    }
    node.hidden = false;
    const canPickFolder = typeof window.showDirectoryPicker === 'function';
    const reopen = !this.vfs && this.reopenHandle
      ? `<button type="button" class="empty-btn primary" data-empty-action="reopen">Reopen ${escapeText(this.reopenHandle.name)}</button>`
      : '';
    const actions = `
      <div class="empty-actions">
        ${reopen}
        ${canPickFolder ? `<button type="button" class="empty-btn${reopen ? '' : ' primary'}" data-empty-action="open-folder">${icon('folder', { size: 16 })}Open folder</button>` : ''}
        <button type="button" class="empty-btn${canPickFolder ? '' : ' primary'}" data-empty-action="pick-files">Pick files</button>
      </div>`;

    if (!this.vfs) {
      node.innerHTML = `
        <div class="empty-card">
          <h2 class="empty-title">Open a robot description</h2>
          <p class="empty-body">Choose the root of a ROS package or workspace, or a MuJoCo model folder. Files are read on this device and never uploaded.</p>
          ${actions}
          <p class="empty-foot">${canPickFolder ? 'You can also drop a folder here. ' : ''}Reads URDF, xacro and MuJoCo MJCF, with STL, DAE, OBJ and glTF meshes.</p>
        </div>`;
      return;
    }

    const root = `${this.vfs.root}/`;
    const label = escapeText(this.vfs.label);
    if (this.candidates.length === 0) {
      node.innerHTML = `
        <div class="empty-card">
          <h2 class="empty-title">No robot files found</h2>
          <p class="empty-body"><b>${label}</b> has no URDF, xacro or MJCF files. Pick the package or workspace root that contains them.</p>
          ${actions}
        </div>`;
      return;
    }

    const shown = this.candidates.slice(0, 8);
    const rest = this.candidates.length - shown.length;
    node.innerHTML = `
      <div class="empty-card wide">
        <h2 class="empty-title">Choose a robot</h2>
        <p class="empty-body">${this.candidates.length} description files in <b>${label}</b></p>
        <ul class="empty-files">
          ${shown.map(path => {
            const relative = path.startsWith(root) ? path.slice(root.length) : path;
            const slash = relative.lastIndexOf('/');
            const dir = slash >= 0 ? relative.slice(0, slash) : '';
            const name = relative.slice(slash + 1);
            return `<li><button type="button" data-empty-action="open-file" data-path="${escapeText(path)}">${icon('description', { size: 16 })}<span class="empty-file-name">${escapeText(name)}</span><span class="empty-file-dir"><bdi>${escapeText(dir)}</bdi></span></button></li>`;
          }).join('')}
        </ul>
        ${rest > 0 ? `<p class="empty-foot">${rest} more in the file menu above</p>` : ''}
      </div>`;
  }

  private async handleOpenDirectory(): Promise<void> {
    if (!window.showDirectoryPicker) {
      return;
    }
    let handle: FileSystemDirectoryHandle;
    try {
      handle = await window.showDirectoryPicker({ id: 'urdf-studio', mode: 'read' });
    } catch (error) {
      if ((error as DOMException)?.name === 'AbortError') {
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      this.renderStatus({ type: 'error', message: 'Could not open folder.' });
      this.toast.push({ kind: 'error', message: 'Could not open folder', detail });
      return;
    }
    // Persist so the next visit can offer to reopen it. Best-effort: ignore
    // failures (private mode, no IndexedDB).
    void setStoredDirectoryHandle(handle).catch(() => undefined);
    await this.scanHandle(handle);
  }

  /** Scan a directory handle into a VFS, applying the open-token race guard
   *  and aborting any previous in-flight scan. */
  private async scanHandle(handle: FileSystemDirectoryHandle): Promise<void> {
    // A newer open supersedes any in-flight one.
    this.activeScan?.abort();
    const controller = new AbortController();
    this.activeScan = controller;
    const token = ++this.openToken;

    try {
      this.renderStatus({ type: 'progress', message: `Scanning ${handle.name}...` });
      const vfs = await DirectoryHandleVfs.create(handle, {
        signal: controller.signal,
        onProgress: (fileCount, dirCount) => {
          if (token === this.openToken) {
            this.renderStatus({ type: 'progress', message: `Scanning ${handle.name}: ${fileCount} files, ${dirCount} dirs` });
          }
        }
      });
      // A newer open started while we were scanning — discard this result so
      // the latest open wins. Dispose the now-orphaned VFS.
      if (token !== this.openToken) {
        vfs.dispose();
        return;
      }
      this.setVfs(vfs);
    } catch (error) {
      if ((error as DOMException)?.name === 'AbortError') {
        return;
      }
      if (token !== this.openToken) {
        return;
      }
      const detail = error instanceof Error ? error.message : String(error);
      this.renderStatus({ type: 'error', message: 'Could not open folder.' });
      this.toast.push({ kind: 'error', message: 'Could not open folder', detail });
    } finally {
      if (this.activeScan === controller) {
        this.activeScan = null;
      }
    }
  }

  private async handleFileList(files: FileList): Promise<void> {
    // FileListVfs construction is synchronous, but still bump the token and
    // abort any in-flight directory scan so a pending folder open can't
    // overwrite this selection.
    this.activeScan?.abort();
    this.activeScan = null;
    const token = ++this.openToken;
    try {
      this.renderStatus({ type: 'progress', message: 'Indexing files...' });
      const vfs = new FileListVfs(files);
      if (token !== this.openToken) {
        vfs.dispose();
        return;
      }
      this.setVfs(vfs);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      this.renderStatus({ type: 'error', message: 'Could not load files.' });
      this.toast.push({ kind: 'error', message: 'Could not load files', detail });
    }
  }

  /** On startup, look up the persisted directory handle (if any) and surface a
   *  "Reopen <name>" button. Permission must be re-granted on a user gesture,
   *  so we cannot scan here — we only reveal the affordance. */
  private async maybeOfferReopen(): Promise<void> {
    // Only the File System Access path can persist; FileListVfs can't.
    if (!canPersistHandles() || !window.showDirectoryPicker) {
      return;
    }
    const handle = await getStoredDirectoryHandle().catch(() => null);
    if (!handle) {
      return;
    }
    const button = document.getElementById('reopen-directory') as HTMLButtonElement | null;
    if (!button) {
      return;
    }
    button.hidden = false;
    button.textContent = `Reopen ${handle.name}`;
    button.title = `Reopen the last folder: ${handle.name}`;
    button.addEventListener('click', () => void this.reopenStoredHandle(handle, button));
    this.reopenHandle = handle;
    this.renderEmptyState();
  }

  /** Re-grant permission for a stored handle (requires the user gesture this
   *  click provides) and rebuild the VFS. Clears the stored handle on denial
   *  or if it has gone stale. */
  private async reopenStoredHandle(handleRaw: FileSystemDirectoryHandle, button: HTMLButtonElement): Promise<void> {
    const handle = handleRaw as PermissionableHandle;
    try {
      let state: PermissionState = 'granted';
      if (typeof handle.queryPermission === 'function') {
        state = await handle.queryPermission({ mode: 'read' });
      }
      if (state !== 'granted' && typeof handle.requestPermission === 'function') {
        state = await handle.requestPermission({ mode: 'read' });
      }
      if (state !== 'granted') {
        this.toast.push({ kind: 'warning', message: 'Folder access was not granted.' });
        return;
      }
      button.hidden = true;
      this.reopenHandle = null;
      await this.scanHandle(handle);
    } catch (error) {
      // A stale/invalid handle (folder moved/deleted, or NotFoundError on
      // permission) — drop it and fall back to the empty state.
      button.hidden = true;
      this.reopenHandle = null;
      this.renderEmptyState();
      void clearStoredDirectoryHandle().catch(() => undefined);
      const detail = error instanceof Error ? error.message : String(error);
      this.toast.push({ kind: 'error', message: 'Could not reopen the last folder', detail });
    }
  }

  private setVfs(vfs: BrowserVfs): void {
    if (this.vfs) {
      this.vfs.dispose();
    }
    // Reset the active selection: the previously-open document pointed into the
    // now-disposed VFS, so it must not linger (the host would otherwise keep
    // reloading a path that no longer exists).
    this.currentFile = null;
    this.vfs = vfs;
    setActiveVfs(vfs);
    this.renderStatus({ type: 'progress', message: `Looking for robot files in ${vfs.label}…` });
    void this.populateFileSelect().then(() => {
      if (this.vfs === vfs) {
        this.renderStatus({ type: 'info', message: `Opened ${vfs.label}` });
      }
    });
  }

  private async populateFileSelect(): Promise<void> {
    const select = document.getElementById('file-select') as HTMLSelectElement;
    const vfs = this.vfs;
    if (!vfs) {
      return;
    }
    const files = vfs.allFiles();
    const mjcf = await findMjcfFiles(vfs, files);
    if (this.vfs !== vfs) {
      return; // A newer folder replaced this one while we were reading.
    }
    const candidates = rankRobotFiles([...files.filter(path => URDF_PATTERNS.test(path)), ...mjcf]);
    this.candidates = candidates;
    select.innerHTML = '';
    if (candidates.length === 0) {
      select.appendChild(new Option('No URDF, xacro or MJCF found', ''));
      select.disabled = true;
      this.renderEmptyState();
      return;
    }
    select.disabled = false;
    select.appendChild(new Option(`Choose a robot (${candidates.length})`, ''));
    for (const path of candidates) {
      select.appendChild(new Option(path.replace(`${vfs.root}/`, ''), path));
    }
    // Auto-load the first if there is only one.
    if (candidates.length === 1) {
      select.value = candidates[0];
      this.currentFile = candidates[0];
      void this.host.openDocument(candidates[0]);
    }
    this.renderEmptyState();
  }

  private renderStatus(status: HostStatus): void {
    const node = document.getElementById('topbar-status');
    if (!node) {
      return;
    }
    if (status.type === 'idle') {
      node.hidden = true;
      node.textContent = '';
      return;
    }
    node.hidden = false;
    node.dataset.kind = status.type;
    node.textContent = status.message;
    if (status.type === 'info') {
      // Auto-clear non-error statuses after a few seconds.
      window.setTimeout(() => {
        if (node.textContent === status.message) {
          node.hidden = true;
        }
      }, 4000);
    }
  }

  private openSettings(): void {
    const dialog = document.getElementById('settings-dialog') as HTMLDialogElement;
    const form = document.getElementById('settings-form') as HTMLFormElement;
    const settings = getSettings();
    (form.elements.namedItem('defaultRenderMode') as HTMLSelectElement).value = settings.defaultRenderMode;
    (form.elements.namedItem('upAxis') as HTMLSelectElement).value = settings.upAxis;
    (form.elements.namedItem('defaultXacroArgs') as HTMLTextAreaElement).value =
      Object.keys(settings.defaultXacroArgs).length > 0
        ? JSON.stringify(settings.defaultXacroArgs, null, 2)
        : '';
    (form.elements.namedItem('packageRoots') as HTMLTextAreaElement).value = settings.packageRoots.join('\n');
    (form.elements.namedItem('semanticFiles') as HTMLTextAreaElement).value = settings.semanticFiles.join('\n');

    const onClose = () => {
      dialog.removeEventListener('close', onClose);
      if (dialog.returnValue !== 'save') {
        return;
      }
      const next: UserSettings = {
        defaultRenderMode: (form.elements.namedItem('defaultRenderMode') as HTMLSelectElement).value as UserSettings['defaultRenderMode'],
        upAxis: (form.elements.namedItem('upAxis') as HTMLSelectElement).value as UserSettings['upAxis'],
        defaultXacroArgs: parseJsonObject((form.elements.namedItem('defaultXacroArgs') as HTMLTextAreaElement).value),
        packageRoots: splitLines((form.elements.namedItem('packageRoots') as HTMLTextAreaElement).value),
        semanticFiles: splitLines((form.elements.namedItem('semanticFiles') as HTMLTextAreaElement).value)
      };
      saveSettings(next);
      if (this.host.applySettingsToActive()) {
        this.renderStatus({ type: 'progress', message: 'Settings saved. Reloading the robot…' });
      } else {
        this.renderStatus({ type: 'info', message: 'Settings saved.' });
      }
    };
    dialog.addEventListener('close', onClose);
    dialog.showModal();
  }
}

/** The .xml files in `files` whose root element is <mujoco>. */
async function findMjcfFiles(vfs: BrowserVfs, files: string[]): Promise<string[]> {
  const probes = files.filter(path => XML_CANDIDATE.test(path) && !NOT_A_MODEL.test(path)).slice(0, MAX_XML_PROBES);
  const results = await Promise.all(probes.map(async path => {
    try {
      return isMjcfContent(await vfs.readText(path)) ? path : undefined;
    } catch {
      return undefined;
    }
  }));
  return results.filter((path): path is string => path !== undefined);
}

/** Order description files so complete robots come before the helper
 *  macros, argument files and SRDFs that live beside them. */
function rankRobotFiles(paths: string[]): string[] {
  const score = (path: string): number => {
    const lower = path.toLowerCase();
    const name = lower.slice(lower.lastIndexOf('/') + 1);
    let value = 0;
    if (/\.(urdf(\.xacro)?|xml|mjcf)$/.test(name)) value += 3;
    // MuJoCo Menagerie convention: scene.xml = robot + floor + lights.
    if (name === 'scene.xml') value += 1;
    if (/(^|\/)robots?\//.test(lower)) value += 2;
    if (name.includes('srdf')) value -= 6;
    if (/(macro|argument|common|util|inertial|transmission|gazebo|ros2_control|material|properties)/.test(name)) value -= 3;
    return value;
  };
  const depth = (path: string): number => path.split('/').length;
  return paths
    .map(path => ({ path, score: score(path), depth: depth(path) }))
    .sort((a, b) => b.score - a.score || a.depth - b.depth || a.path.localeCompare(b.path))
    .map(entry => entry.path);
}

function escapeText(value: string): string {
  return value.replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] ?? ch);
}

function parseJsonObject(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (!trimmed) {
    return {};
  }
  try {
    const parsed = JSON.parse(trimmed);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function splitLines(raw: string): string[] {
  return raw.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
}

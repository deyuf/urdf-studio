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

const URDF_PATTERNS = /\.(urdf|xacro|urdf\.xacro)$/i;

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
          <img src="./icon.png" alt="" class="brand-icon" width="28" height="28">
          URDF Studio
          <span class="brand-tag">Web</span>
        </div>
        <div class="topbar-actions">
          <button id="open-directory" class="primary" title="Open a ROS package folder">Open Folder</button>
          <button id="reopen-directory" class="ghost" title="Reopen the last folder you used" hidden></button>
          <button id="open-files" class="ghost" title="Fallback if your browser does not support folder picker">Pick Files</button>
          <select id="file-select" disabled>
            <option value="">No folder loaded</option>
          </select>
          <a id="docs-link" class="ghost-link" href="./docs/" title="Open documentation" target="_blank" rel="noopener">Docs</a>
          <div id="theme-mount" class="theme-mount"></div>
          <button id="help-btn" class="ghost icon-btn" aria-label="Show onboarding tour" title="Show the onboarding tour">${icon('help', { size: 18 })}</button>
          <button id="settings-btn" class="ghost icon-btn" aria-label="Settings" title="Settings">${icon('settings', { size: 18 })}</button>
        </div>
      </div>
      <div id="topbar-status" class="topbar-status" hidden></div>
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
    const settingsBtn = document.getElementById('settings-btn') as HTMLButtonElement;
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
        void this.host.openDocument(fileSelect.value);
      }
    });
    settingsBtn.addEventListener('click', () => this.openSettings());
    helpBtn.addEventListener('click', () => this.onboarding.open());

    const themeMount = document.getElementById('theme-mount') as HTMLElement;
    mountThemeSwitcher(themeMount);
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
      await this.scanHandle(handle);
    } catch (error) {
      // A stale/invalid handle (folder moved/deleted, or NotFoundError on
      // permission) — drop it and fall back to the empty state.
      button.hidden = true;
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
    this.populateFileSelect();
    this.renderStatus({ type: 'info', message: `Loaded ${vfs.label}. Select a URDF file to view.` });
  }

  private populateFileSelect(): void {
    const select = document.getElementById('file-select') as HTMLSelectElement;
    if (!this.vfs) {
      return;
    }
    const candidates = this.vfs.allFiles().filter(path => URDF_PATTERNS.test(path));
    select.innerHTML = '';
    if (candidates.length === 0) {
      select.appendChild(new Option('No URDF/xacro found', ''));
      select.disabled = true;
      return;
    }
    select.disabled = false;
    select.appendChild(new Option(`${candidates.length} files — pick one`, ''));
    for (const path of candidates) {
      select.appendChild(new Option(path.replace(`${this.vfs.root}/`, ''), path));
    }
    // Auto-load the first if there is only one.
    if (candidates.length === 1) {
      select.value = candidates[0];
      this.currentFile = candidates[0];
      void this.host.openDocument(candidates[0]);
    }
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
      this.renderStatus({ type: 'info', message: 'Settings saved. Reload the model to apply.' });
    };
    dialog.addEventListener('close', onClose);
    dialog.showModal();
  }
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

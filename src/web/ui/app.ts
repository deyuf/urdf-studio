// Top-level browser UI: directory picker, file selector, status bar, settings.

import { DirectoryHandleVfs } from '../vfs/directoryHandle';
import { FileListVfs } from '../vfs/fileList';
import { setActiveVfs } from '../ioBrowser';
import { getSettings, saveSettings, type UserSettings } from '../storage';
import type { BrowserVfs } from '../vfs/types';
import type { WebHost, HostStatus } from '../host';

const URDF_PATTERNS = /\.(urdf|xacro|urdf\.xacro)$/i;

declare global {
  interface Window {
    showDirectoryPicker?: (options?: { id?: string; mode?: 'read' | 'readwrite' }) => Promise<FileSystemDirectoryHandle>;
  }
}

export class AppShell {
  private vfs: BrowserVfs | null = null;
  private currentFile: string | null = null;

  constructor(private readonly host: WebHost) {
    this.render();
    this.host.setListeners({
      onStatus: status => this.renderStatus(status)
    });
  }

  private render(): void {
    const topbar = document.getElementById('topbar');
    if (!topbar) {
      return;
    }
    topbar.innerHTML = `
      <div class="topbar-row">
        <div class="brand">URDF Studio <span class="brand-tag">Web</span></div>
        <div class="topbar-actions">
          <button id="open-directory" class="primary" title="Open a ROS package folder">Open Folder</button>
          <button id="open-files" class="ghost" title="Fallback if your browser does not support folder picker">Pick Files</button>
          <select id="file-select" disabled>
            <option value="">No folder loaded</option>
          </select>
          <a id="docs-link" class="ghost-link" href="./docs/" title="Open documentation" target="_blank" rel="noopener">Docs</a>
          <button id="settings-btn" class="ghost" aria-label="Settings">⚙</button>
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
            <button value="cancel" type="reset" formnovalidate>Cancel</button>
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
  }

  private async handleOpenDirectory(): Promise<void> {
    if (!window.showDirectoryPicker) {
      return;
    }
    try {
      const handle = await window.showDirectoryPicker({ id: 'urdf-studio', mode: 'read' });
      this.renderStatus({ type: 'progress', message: `Scanning ${handle.name}...` });
      const vfs = await DirectoryHandleVfs.create(handle, {
        onProgress: (fileCount, dirCount) => {
          this.renderStatus({ type: 'progress', message: `Scanning ${handle.name}: ${fileCount} files, ${dirCount} dirs` });
        }
      });
      this.setVfs(vfs);
    } catch (error) {
      if ((error as DOMException)?.name === 'AbortError') {
        return;
      }
      this.renderStatus({ type: 'error', message: `Could not open folder: ${String(error)}` });
    }
  }

  private async handleFileList(files: FileList): Promise<void> {
    try {
      this.renderStatus({ type: 'progress', message: 'Indexing files...' });
      const vfs = new FileListVfs(files);
      this.setVfs(vfs);
    } catch (error) {
      this.renderStatus({ type: 'error', message: `Could not load files: ${String(error)}` });
    }
  }

  private setVfs(vfs: BrowserVfs): void {
    if (this.vfs) {
      this.vfs.dispose();
    }
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

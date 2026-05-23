// Source-pane: CodeMirror 6 powered editor for URDF / xacro files.
//
// Maintains the legacy interface (mountSourcePane / setActiveLine /
// mountedLineCount / activeLine / dispose) so callers don't need to
// change. Adds new optional callbacks (onChange, onSave) the renderer
// uses when the user enables editing.

import { mountUrdfEditor, type UrdfEditorHandle } from '../../editor';
import type { CompletionContextProvider } from '../../editor/completion';
import type { LinterContext } from '../../editor/lintAdapter';
import type { StudioDiagnostic } from '../../core/types';

export interface SourcePaneInput {
  fileName: string;
  format: 'urdf' | 'xacro';
  urdf: string;
  /** When true, the editor accepts text edits. */
  editable?: boolean;
  /** Diagnostics from the most recent analysis. */
  diagnostics?: StudioDiagnostic[];
  /** Source of completions (link/joint names etc). */
  completionProvider?: CompletionContextProvider;
  /** Called (debounced by the host) on each document change. */
  onChange?: (text: string) => void;
  /** Called when the user presses Ctrl/Cmd+S. */
  onSave?: (text: string) => void;
  /** Called when the user clicks a gutter line number. */
  onLineClick?: (line: number) => void;
}

export interface SourcePane {
  setActiveLine(line: number | undefined): void;
  /** For tests + diagnostics: how many lines the editor currently holds. */
  mountedLineCount(): number;
  /** For tests: which line is currently highlighted (1-based). */
  activeLine(): number | undefined;
  /** Refresh diagnostics displayed inline. */
  refreshDiagnostics(diagnostics: StudioDiagnostic[]): void;
  /** Get current document text. */
  getText(): string;
  /** Toggle read-only mode. */
  setEditable(editable: boolean): void;
  /** Underlying editor handle (test escape hatch). */
  editor: UrdfEditorHandle;
  dispose(): void;
}

// Kept exported for backwards-compat with the older virtualisation tests —
// CodeMirror 6 handles virtualisation internally so we no longer act on
// this value, but other code may import it.
export const VIRTUALIZE_THRESHOLD_LINES = 2000;

const EMPTY_PROVIDER: CompletionContextProvider = {
  linkNames: () => [],
  jointNames: () => [],
  movableJointNames: () => [],
  packageNames: () => []
};

export function mountSourcePane(host: HTMLElement, input: SourcePaneInput): SourcePane {
  while (host.firstChild) {
    host.removeChild(host.firstChild);
  }

  // Top toolbar (filename + edit toggle + fullscreen).
  const toolbar = document.createElement('div');
  toolbar.className = 'source-toolbar';
  const meta = document.createElement('div');
  meta.className = 'source-meta';
  const lineCount = input.urdf.split('\n').length;
  meta.textContent = `${input.fileName} · ${lineCount} lines${input.format === 'xacro' ? ' (expanded xacro)' : ''}`;
  toolbar.appendChild(meta);

  const editToggle = document.createElement('button');
  editToggle.type = 'button';
  editToggle.className = 'source-edit-toggle';
  editToggle.textContent = input.editable ? 'Edit: on' : 'Edit: off';
  editToggle.title = 'Toggle source editing';
  if (input.editable) editToggle.classList.add('active');
  toolbar.appendChild(editToggle);

  const fullscreenButton = document.createElement('button');
  fullscreenButton.type = 'button';
  fullscreenButton.className = 'source-fullscreen-toggle';
  fullscreenButton.textContent = 'Fullscreen';
  fullscreenButton.title = 'Toggle source fullscreen (F11)';
  toolbar.appendChild(fullscreenButton);

  host.appendChild(toolbar);

  // Editor host.
  const editorHost = document.createElement('div');
  editorHost.className = 'editor-host';
  host.appendChild(editorHost);

  // Status bar.
  const status = document.createElement('div');
  status.className = 'editor-status';
  host.appendChild(status);

  let activeLine: number | undefined;
  let currentDiagnostics: StudioDiagnostic[] = input.diagnostics ?? [];

  const linterContext: LinterContext = {
    getDiagnostics: () => currentDiagnostics
  };

  const editor = mountUrdfEditor(editorHost, {
    text: input.urdf,
    readOnly: !input.editable,
    format: input.format,
    completionProvider: input.completionProvider ?? EMPTY_PROVIDER,
    linterContext,
    onChange: input.onChange,
    onSave: input.onSave,
    onLineClick: input.onLineClick
  });

  // Track edit toggle.
  editToggle.addEventListener('click', () => {
    const enabling = !editToggle.classList.contains('active');
    editToggle.classList.toggle('active', enabling);
    editToggle.textContent = enabling ? 'Edit: on' : 'Edit: off';
    editor.setReadOnly(!enabling);
  });

  fullscreenButton.addEventListener('click', () => {
    const event = new CustomEvent('urdf-studio:request-fullscreen-toggle', { bubbles: true });
    host.dispatchEvent(event);
  });

  function renderStatus(diagnostics: StudioDiagnostic[]): void {
    const errors = diagnostics.filter(d => d.severity === 'error').length;
    const warnings = diagnostics.filter(d => d.severity === 'warning').length;
    const lines = editor.lineCount();
    status.innerHTML = '';
    const linesEl = document.createElement('span');
    linesEl.textContent = `${lines} lines`;
    status.appendChild(linesEl);
    if (errors > 0) {
      const errEl = document.createElement('span');
      errEl.className = 'status-error';
      errEl.textContent = `${errors} error${errors === 1 ? '' : 's'}`;
      status.appendChild(errEl);
    }
    if (warnings > 0) {
      const warnEl = document.createElement('span');
      warnEl.className = 'status-dirty';
      warnEl.textContent = `${warnings} warning${warnings === 1 ? '' : 's'}`;
      status.appendChild(warnEl);
    }
  }

  renderStatus(currentDiagnostics);

  return {
    setActiveLine(line) {
      activeLine = line;
      editor.setActiveLine(line);
    },
    mountedLineCount: () => editor.lineCount(),
    activeLine: () => activeLine,
    refreshDiagnostics(diagnostics) {
      currentDiagnostics = diagnostics;
      editor.refreshLint();
      renderStatus(diagnostics);
    },
    getText: () => editor.getText(),
    setEditable(editable) {
      editToggle.classList.toggle('active', editable);
      editToggle.textContent = editable ? 'Edit: on' : 'Edit: off';
      editor.setReadOnly(!editable);
    },
    editor,
    dispose() {
      editor.dispose();
    }
  };
}

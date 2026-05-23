// CodeMirror-6 powered URDF / xacro editor. Single entry point for both
// the VS Code webview and the browser web app.
//
// The editor is intentionally stateless from the renderer's point of view:
// mountUrdfEditor() creates a fresh instance per loadRobot message; the
// returned handle exposes setActiveLine / replaceText / dispose so the
// renderer can shuttle data in and out without knowing the CM6 API.

import { EditorState, type Extension, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { searchKeymap, highlightSelectionMatches } from '@codemirror/search';
import { bracketMatching, foldGutter, foldKeymap, indentOnInput, syntaxHighlighting } from '@codemirror/language';
import { autocompletion, closeBrackets, closeBracketsKeymap, completionKeymap } from '@codemirror/autocomplete';
import { lintKeymap } from '@codemirror/lint';
import { xml } from '@codemirror/lang-xml';

import { urdfHighlight, urdfStructuralPlugin } from './highlight';
import { urdfTheme } from './theme';
import { urdfLintExtensions, pushLint, type LinterContext } from './lintAdapter';
import { urdfCompletionSource, type CompletionContextProvider } from './completion';

export interface UrdfEditorOptions {
  /** Initial document text. */
  text: string;
  /** Whether editing is allowed. */
  readOnly?: boolean;
  /** Whether the document is xacro (affects completion lists). */
  format: 'urdf' | 'xacro';
  /** Provides live link / joint names for semantic completion. */
  completionProvider: CompletionContextProvider;
  /** Provides current lint report + asks for a refresh when document changes. */
  linterContext: LinterContext;
  /** Called (debounced) when the document text changes. */
  onChange?: (text: string) => void;
  /** Called when the user presses Ctrl/Cmd+S. */
  onSave?: (text: string) => void;
  /** Called when the user clicks a gutter line number. */
  onLineClick?: (line: number) => void;
}

export interface UrdfEditorHandle {
  /** Highlight (and scroll into view) a 1-based line number. */
  setActiveLine(line: number | undefined): void;
  /** Replace entire document. Used when the host reloads a different file. */
  replaceText(text: string): void;
  /** Force a lint refresh — called after the host re-analyzes the model. */
  refreshLint(): void;
  /** Return the current document text. */
  getText(): string;
  /** Switch readOnly state without remounting. */
  setReadOnly(readOnly: boolean): void;
  /** Editor DOM element (the .cm-editor container). */
  dom: HTMLElement;
  /** Number of mounted lines (test helper). */
  lineCount(): number;
  /** Tear down listeners. */
  dispose(): void;
}

export function mountUrdfEditor(host: HTMLElement, options: UrdfEditorOptions): UrdfEditorHandle {
  while (host.firstChild) {
    host.removeChild(host.firstChild);
  }

  const readOnlyCompartment = new Compartment();

  let activeLineEffect = -1;

  const extensions: Extension[] = [
    lineNumbers({
      domEventHandlers: {
        click: (view, lineInfo) => {
          const line = view.state.doc.lineAt(lineInfo.from).number;
          options.onLineClick?.(line);
          return false;
        }
      }
    }),
    foldGutter(),
    history(),
    indentOnInput(),
    bracketMatching(),
    closeBrackets(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    highlightSelectionMatches(),
    xml(),
    syntaxHighlighting(urdfHighlight),
    urdfStructuralPlugin,
    urdfTheme,
    autocompletion({
      override: [urdfCompletionSource(options.completionProvider, options.format)],
      activateOnTyping: true,
      closeOnBlur: true,
      // Render slight description popups
      tooltipClass: () => 'cm-urdf-tooltip'
    }),
    ...urdfLintExtensions(),
    readOnlyCompartment.of(EditorState.readOnly.of(options.readOnly ?? false)),
    keymap.of([
      ...closeBracketsKeymap,
      ...defaultKeymap,
      ...searchKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...completionKeymap,
      ...lintKeymap,
      indentWithTab,
      {
        key: 'Mod-s',
        preventDefault: true,
        run: view => {
          options.onSave?.(view.state.doc.toString());
          return true;
        }
      }
    ])
  ];

  if (options.onChange) {
    extensions.push(EditorView.updateListener.of(update => {
      if (update.docChanged) {
        options.onChange!(update.state.doc.toString());
      }
    }));
  }

  const state = EditorState.create({ doc: options.text, extensions });
  const view = new EditorView({ state, parent: host });

  // Push initial diagnostics. We intentionally do this AFTER construction
  // returns so callers that capture the handle synchronously see the
  // dispatch in their next microtask, not inside CM6's mount path.
  if (typeof queueMicrotask === 'function') {
    queueMicrotask(() => { try { pushLint(view, options.linterContext); } catch { /* JSDOM tests */ } });
  }

  function setActiveLine(line: number | undefined): void {
    activeLineEffect = line ?? -1;
    if (line === undefined) {
      // Remove decorations by issuing a no-op selection (CM6 highlights
      // the cursor line by default — moving the cursor off the previous
      // location achieves the desired "no active line" feel).
      return;
    }
    if (line < 1 || line > view.state.doc.lines) {
      return;
    }
    const lineInfo = view.state.doc.line(line);
    view.dispatch({
      selection: { anchor: lineInfo.from },
      effects: EditorView.scrollIntoView(lineInfo.from, { y: 'center' })
    });
  }

  function replaceText(text: string): void {
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
  }

  function refreshLint(): void {
    pushLint(view, options.linterContext);
  }

  function getText(): string {
    return view.state.doc.toString();
  }

  function setReadOnly(readOnly: boolean): void {
    view.dispatch({ effects: readOnlyCompartment.reconfigure(EditorState.readOnly.of(readOnly)) });
  }

  return {
    setActiveLine,
    replaceText,
    refreshLint,
    getText,
    setReadOnly,
    dom: view.dom,
    lineCount: () => view.state.doc.lines,
    dispose() {
      void activeLineEffect;
      view.destroy();
    }
  };
}

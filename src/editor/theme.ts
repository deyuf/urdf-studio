// CodeMirror theme mapped to the same VS Code CSS variables the Studio UI
// already uses. The colours below are class names — the actual hues live
// in src/editor/editor.css so designers can tweak without touching JS.

import { EditorView } from '@codemirror/view';

export const urdfTheme = EditorView.theme({
  '&': {
    height: '100%',
    fontSize: 'var(--cm-urdf-font-size, 13px)',
    backgroundColor: 'var(--vscode-editor-background, transparent)',
    color: 'var(--vscode-editor-foreground, inherit)'
  },
  '.cm-scroller': {
    fontFamily: 'var(--vscode-editor-font-family, ui-monospace, Menlo, Consolas, monospace)',
    lineHeight: '1.55'
  },
  '.cm-content': {
    paddingBlock: '8px',
    caretColor: 'var(--vscode-editorCursor-foreground, currentColor)'
  },
  '.cm-gutters': {
    backgroundColor: 'transparent',
    color: 'var(--vscode-editorLineNumber-foreground, var(--vscode-descriptionForeground))',
    border: 'none',
    borderRight: '1px solid var(--vscode-panel-border)'
  },
  '.cm-activeLineGutter, .cm-activeLine': {
    backgroundColor: 'color-mix(in srgb, var(--vscode-editor-selectionBackground, var(--vscode-focusBorder)) 25%, transparent)'
  },
  '.cm-cursor, .cm-dropCursor': {
    borderLeftColor: 'var(--vscode-editorCursor-foreground, currentColor)'
  },
  '&.cm-focused .cm-selectionBackground, ::selection': {
    backgroundColor: 'var(--vscode-editor-selectionBackground, rgba(0, 122, 204, 0.25))'
  },
  '.cm-tooltip': {
    border: '1px solid var(--vscode-panel-border)',
    backgroundColor: 'var(--vscode-editorHoverWidget-background, var(--vscode-sideBar-background))',
    color: 'var(--vscode-foreground)',
    fontSize: '11.5px'
  },
  '.cm-tooltip.cm-tooltip-autocomplete': {
    '& > ul > li[aria-selected]': {
      backgroundColor: 'var(--vscode-list-activeSelectionBackground, var(--vscode-focusBorder))',
      color: 'var(--vscode-list-activeSelectionForeground, var(--vscode-foreground))'
    }
  },
  '.cm-diagnostic': {
    padding: '4px 8px',
    fontSize: '11.5px'
  },
  '.cm-diagnostic-error': {
    borderLeft: '3px solid var(--vscode-editorError-foreground, #f48771)'
  },
  '.cm-diagnostic-warning': {
    borderLeft: '3px solid var(--vscode-editorWarning-foreground, #cca700)'
  },
  '.cm-diagnostic-info': {
    borderLeft: '3px solid var(--vscode-editorInfo-foreground, #75beff)'
  }
});

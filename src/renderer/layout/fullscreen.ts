// Workspace layout controller — manages three modes:
//   default              ← 3D left, side panel right (legacy)
//   layout-source-fullscreen ← source pane fills, 3D shrinks to PIP
//   layout-split         ← 50/50 viewport vs source
//
// State lives entirely as a CSS class on .workspace so the renderer only
// has to dispatch resize/render-now after a transition.

export type LayoutMode = 'default' | 'source-fullscreen' | 'split';

const LAYOUT_CLASSES: Record<LayoutMode, string | null> = {
  'default': null,
  'source-fullscreen': 'layout-source-fullscreen',
  'split': 'layout-split'
};

export interface LayoutController {
  current(): LayoutMode;
  set(mode: LayoutMode): void;
  cycle(): LayoutMode;
  dispose(): void;
}

const ALL: LayoutMode[] = ['default', 'split', 'source-fullscreen'];

export function createLayoutController(
  workspace: HTMLElement,
  onChange?: (mode: LayoutMode) => void
): LayoutController {
  let mode: LayoutMode = 'default';

  function applyClass(): void {
    for (const candidate of Object.values(LAYOUT_CLASSES)) {
      if (candidate) workspace.classList.remove(candidate);
    }
    const cls = LAYOUT_CLASSES[mode];
    if (cls) workspace.classList.add(cls);
  }

  function set(next: LayoutMode): void {
    if (mode === next) return;
    mode = next;
    applyClass();
    onChange?.(mode);
  }

  // Keyboard: F11 (when not in an input) toggles source-fullscreen.
  const handler = (event: KeyboardEvent): void => {
    if (event.defaultPrevented) return;
    const target = event.target as HTMLElement | null;
    // Don't grab the key while typing in inputs / contenteditable.
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return;
    }
    if (event.key === 'F11') {
      event.preventDefault();
      set(mode === 'source-fullscreen' ? 'default' : 'source-fullscreen');
    } else if ((event.ctrlKey || event.metaKey) && event.shiftKey && event.key.toLowerCase() === 'f') {
      event.preventDefault();
      set(mode === 'source-fullscreen' ? 'default' : 'source-fullscreen');
    }
  };
  window.addEventListener('keydown', handler);

  // Listen for the source pane's custom request-toggle event.
  const customHandler = (): void => {
    set(mode === 'source-fullscreen' ? 'default' : 'source-fullscreen');
  };
  workspace.addEventListener('urdf-studio:request-fullscreen-toggle', customHandler);

  return {
    current: () => mode,
    set,
    cycle() {
      const i = ALL.indexOf(mode);
      const next = ALL[(i + 1) % ALL.length];
      set(next);
      return next;
    },
    dispose() {
      window.removeEventListener('keydown', handler);
      workspace.removeEventListener('urdf-studio:request-fullscreen-toggle', customHandler);
    }
  };
}

// Web entry point. Order of side effects is important:
//   1. Apply the stored theme on <html> immediately (before paint) so the
//      first frame doesn't flash the wrong palette.
//   2. Install CoreIo (browser implementation).
//   3. Install acquireVsCodeApi shim before the renderer module evaluates.
//   4. Mount the UI shell so #app and other DOM nodes exist.
//   5. Lazy-import the renderer.

import { applyThemeImmediate, loadTheme } from './ui/theme';
applyThemeImmediate(loadTheme());

import './ioBrowser';
import { WebHost } from './host';
import { AppShell } from './ui/app';

async function boot(): Promise<void> {
  const host = new WebHost();
  // The AppShell constructor wires itself into the host listeners + DOM; the
  // returned instance is intentionally unreferenced — keeping a _-prefixed
  // local name documents the side-effect without triggering lint warnings.
  const _shell = new AppShell(host);
  void _shell;
  // Boot the renderer last — it owns #app and immediately posts a 'ready'
  // message that the host now listens for.
  await import('../renderer/main.js');
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => void boot());
} else {
  void boot();
}

// Three-mode color theme: light / dark / system. The user's choice is
// persisted in localStorage and applied by setting `data-theme` on
// <html>. CSS uses CSS' light-dark() function gated by `color-scheme:`
// to swap palettes — see web.css.
//
// View Transitions API drives a full-page crossfade between themes
// when supported; older browsers swap instantly.

export type ThemeMode = 'light' | 'dark' | 'system';

const KEY = 'urdf-studio:theme:v1';

const MODE_META: Record<ThemeMode, { icon: string; title: string; aria: string }> = {
  light:  { icon: '☀',  title: 'Light theme',          aria: 'Light theme' },
  system: { icon: '🖥', title: 'Match system theme',   aria: 'Match system theme' },
  dark:   { icon: '🌙', title: 'Dark theme',           aria: 'Dark theme' }
};

export function loadTheme(): ThemeMode {
  try {
    const value = localStorage.getItem(KEY);
    if (value === 'light' || value === 'dark' || value === 'system') {
      return value;
    }
  } catch {
    // localStorage may be disabled (private mode).
  }
  return 'system';
}

export function saveTheme(mode: ThemeMode): void {
  try {
    localStorage.setItem(KEY, mode);
  } catch {
    // ignore
  }
}

/** Apply a mode synchronously (skip the View Transition). Used at startup
 *  so the page never paints with the wrong palette. */
export function applyThemeImmediate(mode: ThemeMode): void {
  document.documentElement.setAttribute('data-theme', mode);
}

/** Apply a mode, wrapped in a View Transition when available. */
export function applyTheme(mode: ThemeMode): void {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (typeof doc.startViewTransition === 'function' && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    doc.startViewTransition(() => applyThemeImmediate(mode));
  } else {
    applyThemeImmediate(mode);
  }
}

/** Render the three-segment theme switcher inside the given container.
 *  Returns a setter that lets external code force-update the active mode. */
export function mountThemeSwitcher(container: HTMLElement): { set(mode: ThemeMode): void } {
  let current = loadTheme();
  applyThemeImmediate(current);

  const switcher = document.createElement('div');
  switcher.className = 'theme-switcher';
  switcher.setAttribute('role', 'radiogroup');
  switcher.setAttribute('aria-label', 'Color theme');

  const modes: ThemeMode[] = ['light', 'system', 'dark'];
  const buttons = new Map<ThemeMode, HTMLButtonElement>();

  for (const mode of modes) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'theme-switcher-btn';
    btn.dataset.theme = mode;
    btn.setAttribute('role', 'radio');
    btn.setAttribute('aria-label', MODE_META[mode].aria);
    btn.title = MODE_META[mode].title;
    btn.textContent = MODE_META[mode].icon;
    btn.addEventListener('click', () => set(mode));
    switcher.appendChild(btn);
    buttons.set(mode, btn);
  }

  function set(mode: ThemeMode): void {
    if (mode === current) {
      return;
    }
    current = mode;
    saveTheme(mode);
    applyTheme(mode);
    syncActiveAttributes();
  }

  function syncActiveAttributes(): void {
    for (const [mode, btn] of buttons) {
      const active = mode === current;
      btn.setAttribute('aria-checked', String(active));
      btn.dataset.active = active ? 'true' : 'false';
    }
  }

  syncActiveAttributes();
  container.appendChild(switcher);

  // Reflect runtime changes in the system theme when the user is in
  // 'system' mode so any color-scheme-driven CSS recomputes cleanly.
  matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (current === 'system') {
      // No data-theme change, but trigger a reflow so transitions kick in.
      document.documentElement.setAttribute('data-theme', 'system');
    }
  });

  return { set };
}

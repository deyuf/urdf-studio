// Inline SVG icon set — Google Material Symbols (Outlined) style.
//
// Every icon is a 24×24 viewBox using `currentColor` so callers control
// the colour via CSS. We use a single shared rendering helper so future
// changes to default size / weight / stroke flow through one place.
//
// Why inline SVG instead of an icon font?
//   * No network request, no woff2 download — works inside the VS Code
//     webview with its strict CSP and inside the web app offline.
//   * Each icon is ~200-400 bytes — together they cost less than the
//     font subset request.
//   * `currentColor` integrates with the existing --vscode-* / --us-*
//     palette without needing a per-icon class.
//
// The path data comes from Google's Material Symbols (Apache 2.0) —
// "Outlined" weight 400 grade 0 optical-size 24. When adding new icons,
// pull from https://fonts.google.com/icons and prefer the same variant
// so the visual language stays cohesive.

export type IconName =
  | 'settings'
  | 'help'
  | 'close'
  | 'fullscreen'
  | 'fullscreen_exit'
  | 'light_mode'
  | 'dark_mode'
  | 'desktop_windows'
  | 'error'
  | 'warning'
  | 'info'
  | 'edit'
  | 'expand_more'
  | 'expand_less'
  | 'open_in_new'
  | 'download'
  | 'content_copy';

interface IconDef {
  /** Inner SVG markup — paths only, no <svg> wrapper. */
  paths: string;
  /** Whether the paths use stroke-only (no fill) drawing. */
  stroked?: boolean;
}

// Material Symbols Outlined — weight 400, optical size 24.
const REGISTRY: Record<IconName, IconDef> = {
  settings: {
    paths: '<path d="M9.25 22 8.85 18.8q-.325-.125-.612-.3q-.288-.175-.563-.375L4.7 19.375L1.95 14.625L4.525 12.675q-.025-.175-.025-.337v-.675q0-.163.025-.338L1.95 9.375L4.7 4.625L7.675 5.875q.275-.2.575-.375q.3-.175.6-.3L9.25 2H14.75L15.15 5.2q.325.125.613.3q.287.175.562.375L19.3 4.625L22.05 9.375L19.475 11.325q.025.175.025.337V12.675L19.475 12.675L22.05 14.625L19.3 19.375L16.325 18.125q-.275.2-.563.375q-.287.175-.612.3L14.75 22ZM12 15q1.25 0 2.125-.875T15 12q0-1.25-.875-2.125T12 9q-1.25 0-2.125.875T9 12q0 1.25.875 2.125T12 15Z"/>'
  },
  help: {
    paths: '<path d="M11.95 18q.525 0 .888-.363q.362-.362.362-.887t-.362-.887q-.363-.363-.888-.363t-.887.363q-.363.362-.363.887t.363.887q.362.363.887.363Zm-.9-3.85h1.85q0-.825.188-1.3q.187-.475.862-1.15q.5-.5.788-.95q.287-.45.287-1.1q0-1.1-.812-1.825T12 7.1q-1.05 0-1.787.55q-.738.55-1.038 1.4l1.65.65q.125-.45.487-.8q.363-.35.913-.35q.575 0 .912.3q.338.3.338.8q0 .425-.25.825q-.25.4-.7.825q-.85.775-1.1 1.275t-.275 1.575ZM12 22q-2.075 0-3.9-.788q-1.825-.787-3.175-2.137q-1.35-1.35-2.137-3.175Q2 14.075 2 12t.788-3.9q.787-1.825 2.137-3.175q1.35-1.35 3.175-2.137Q9.925 2 12 2t3.9.788q1.825.787 3.175 2.137q1.35 1.35 2.137 3.175Q22 9.925 22 12t-.788 3.9q-.787 1.825-2.137 3.175q-1.35 1.35-3.175 2.137Q14.075 22 12 22Zm0-2q3.35 0 5.675-2.325Q20 15.35 20 12q0-3.35-2.325-5.675Q15.35 4 12 4Q8.65 4 6.325 6.325Q4 8.65 4 12q0 3.35 2.325 5.675Q8.65 20 12 20Zm0-8Z"/>'
  },
  close: {
    paths: '<path d="M6.4 19L5 17.6L10.6 12L5 6.4L6.4 5L12 10.6L17.6 5L19 6.4L13.4 12L19 17.6L17.6 19L12 13.4Z"/>'
  },
  fullscreen: {
    paths: '<path d="M5 19V14H7V17H10V19ZM5 10V5H10V7H7V10ZM14 19V17H17V14H19V19ZM17 10V7H14V5H19V10Z"/>'
  },
  fullscreen_exit: {
    paths: '<path d="M5 19V17H8V14H10V19ZM5 10V5H10V7H7V10ZM14 19V14H19V16H16V19ZM14 10V5H16V8H19V10Z"/>'
  },
  light_mode: {
    paths: '<path d="M12 17q-2.075 0-3.537-1.463Q7 14.075 7 12t1.463-3.538Q9.925 7 12 7t3.538 1.462Q17 9.925 17 12q0 2.075-1.462 3.537Q14.075 17 12 17ZM2 13q-.425 0-.712-.288Q1 12.425 1 12t.288-.713Q1.575 11 2 11h2q.425 0 .713.287Q5 11.575 5 12t-.287.712Q4.425 13 4 13Zm18 0q-.425 0-.712-.288Q19 12.425 19 12t.288-.713Q19.575 11 20 11h2q.425 0 .712.287Q23 11.575 23 12t-.288.712Q22.425 13 22 13ZM11 4V2q0-.425.287-.713Q11.575 1 12 1t.713.287Q13 1.575 13 2v2q0 .425-.287.713Q12.425 5 12 5t-.713-.287Q11 4.425 11 4Zm0 18v-2q0-.425.287-.712Q11.575 19 12 19t.713.288Q13 19.575 13 20v2q0 .425-.287.712Q12.425 23 12 23t-.713-.288Q11 22.425 11 22ZM5.65 7.05l-1.1-1.075q-.3-.275-.288-.7q.013-.425.288-.725q.3-.3.725-.3t.7.3l1.075 1.1q.275.3.275.7q0 .4-.275.675q-.275.3-.687.3q-.413 0-.713-.275ZM17.95 19.4l-1.075-1.1q-.275-.3-.275-.712q0-.413.275-.688q.275-.3.687-.3q.413 0 .713.3l1.1 1.075q.3.275.288.7q-.013.425-.288.725q-.3.3-.725.3t-.7-.3ZM16.95 7.05q-.3-.3-.3-.687q0-.388.3-.713l1.075-1.1q.275-.3.7-.288q.425.013.725.288q.3.3.3.725t-.3.7l-1.1 1.075q-.3.275-.7.275q-.4 0-.7-.275ZM4.55 19.4q-.3-.3-.3-.725t.3-.7l1.1-1.075q.3-.275.713-.275q.412 0 .687.275q.3.275.3.687q0 .413-.3.713L5.975 19.4q-.275.3-.7.288q-.425-.013-.725-.288Z"/>'
  },
  dark_mode: {
    paths: '<path d="M12 21q-3.775 0-6.387-2.613Q3 15.775 3 12q0-3.45 2.25-5.988T11 3.05q.325-.05.575.088t.4.362q.15.225.163.525q.012.3-.188.575q-.425.65-.638 1.413Q11.1 6.775 11.1 7.6q0 2.275 1.575 3.85T16.525 13.025q.85 0 1.638-.25q.787-.25 1.412-.7q.275-.2.563-.175q.287.025.512.175q.225.15.35.4q.125.25.075.575q-.45 3.425-3.025 5.688Q15.475 21 12 21Z"/>'
  },
  desktop_windows: {
    paths: '<path d="M8 21V19H10V17H4Q3.175 17 2.588 16.413Q2 15.825 2 15V5Q2 4.175 2.588 3.587Q3.175 3 4 3H20Q20.825 3 21.413 3.587Q22 4.175 22 5V15Q22 15.825 21.413 16.413Q20.825 17 20 17H14V19H16V21ZM4 15H20V5H4V15Z"/>'
  },
  error: {
    paths: '<path d="M12 17q.425 0 .713-.288Q13 16.425 13 16t-.287-.713Q12.425 15 12 15t-.712.287Q11 15.575 11 16t.288.712Q11.575 17 12 17Zm-1-4h2V7h-2ZM12 22q-2.075 0-3.9-.788q-1.825-.787-3.175-2.137q-1.35-1.35-2.137-3.175Q2 14.075 2 12t.788-3.9q.787-1.825 2.137-3.175q1.35-1.35 3.175-2.137Q9.925 2 12 2t3.9.788q1.825.787 3.175 2.137q1.35 1.35 2.137 3.175Q22 9.925 22 12t-.788 3.9q-.787 1.825-2.137 3.175q-1.35 1.35-3.175 2.137Q14.075 22 12 22Z"/>'
  },
  warning: {
    paths: '<path d="M1 21L12 2L23 21ZM12 18q.425 0 .713-.288Q13 17.425 13 17t-.287-.713Q12.425 16 12 16t-.712.287Q11 16.575 11 17t.288.712Q11.575 18 12 18Zm-1-3h2v-5h-2Z"/>'
  },
  info: {
    paths: '<path d="M11 17h2v-6h-2ZM12 9q.425 0 .713-.288Q13 8.425 13 8t-.287-.713Q12.425 7 12 7t-.712.287Q11 7.575 11 8t.288.712Q11.575 9 12 9Zm0 13q-2.075 0-3.9-.788q-1.825-.787-3.175-2.137q-1.35-1.35-2.137-3.175Q2 14.075 2 12t.788-3.9q.787-1.825 2.137-3.175q1.35-1.35 3.175-2.137Q9.925 2 12 2t3.9.788q1.825.787 3.175 2.137q1.35 1.35 2.137 3.175Q22 9.925 22 12t-.788 3.9q-.787 1.825-2.137 3.175q-1.35 1.35-3.175 2.137Q14.075 22 12 22Z"/>'
  },
  edit: {
    paths: '<path d="M5 19H6.4L15.025 10.375L13.625 8.975L5 17.6ZM19.3 8.925L15.05 4.725L16.45 3.325Q17.025 2.75 17.863 2.75T19.275 3.325L20.675 4.725Q21.25 5.3 21.275 6.113Q21.3 6.925 20.725 7.5ZM17.85 10.4L7.25 21H3V16.75L13.6 6.15Z"/>'
  },
  expand_more: {
    paths: '<path d="M12 15.375 6 9.375L7.4 7.975L12 12.575L16.6 7.975L18 9.375Z"/>'
  },
  expand_less: {
    paths: '<path d="M7.4 15.375 6 13.975L12 7.975L18 13.975L16.6 15.375L12 10.775Z"/>'
  },
  open_in_new: {
    paths: '<path d="M5 21Q4.175 21 3.588 20.413Q3 19.825 3 19V5Q3 4.175 3.588 3.587Q4.175 3 5 3H11V5H5V19H19V13H21V19Q21 19.825 20.413 20.413Q19.825 21 19 21ZM9.7 15.7L8.3 14.3L17.6 5H14V3H21V10H19V6.4Z"/>'
  },
  download: {
    paths: '<path d="M12 16L7 11L8.4 9.55L11 12.15V4H13V12.15L15.6 9.55L17 11ZM6 20Q5.175 20 4.588 19.413Q4 18.825 4 18V15H6V18H18V15H20V18Q20 18.825 19.413 19.413Q18.825 20 18 20Z"/>'
  },
  content_copy: {
    paths: '<path d="M9 18Q8.175 18 7.588 17.413Q7 16.825 7 16V4Q7 3.175 7.588 2.587Q8.175 2 9 2H18Q18.825 2 19.413 2.587Q20 3.175 20 4V16Q20 16.825 19.413 17.413Q18.825 18 18 18ZM9 16H18V4H9ZM5 22Q4.175 22 3.588 21.413Q3 20.825 3 20V7H5V20H15V22Z"/>'
  }
};

export interface IconOptions {
  /** Size in px (sets both width and height). Default 16. */
  size?: number;
  /** Extra class name appended to the default `icon`. */
  className?: string;
  /** Optional aria-label; omit for purely decorative icons. */
  label?: string;
}

/**
 * Render an icon as an SVG string. Returns markup intended to be
 * inserted via innerHTML — callers in the codebase already trust
 * static template strings (see html`...` for renderer-side usage).
 */
export function icon(name: IconName, opts: IconOptions = {}): string {
  const def = REGISTRY[name];
  const size = opts.size ?? 16;
  const cls = `icon icon-${name}${opts.className ? ' ' + opts.className : ''}`;
  const a11y = opts.label
    ? `role="img" aria-label="${escapeAttr(opts.label)}"`
    : 'aria-hidden="true" focusable="false"';
  return `<svg class="${cls}" width="${size}" height="${size}" viewBox="0 0 24 24" fill="currentColor" ${a11y}>${def.paths}</svg>`;
}

function escapeAttr(value: string): string {
  return value.replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

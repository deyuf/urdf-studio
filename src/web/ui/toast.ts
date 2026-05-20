// Bottom toast / bubble component for surfacing parse and load errors.
// Errors are sticky (manual dismiss); warnings auto-dismiss; info auto-dismisses.

export type ToastKind = 'error' | 'warning' | 'info';

export interface Toast {
  kind: ToastKind;
  message: string;
  detail?: string;
  durationMs?: number;
}

interface ActiveToast {
  toast: Toast;
  element: HTMLElement;
  timer?: number;
}

const DEFAULT_DURATIONS: Record<ToastKind, number> = {
  info: 4000,
  warning: 7000,
  // Errors are sticky — user must dismiss explicitly.
  error: 0
};

export interface ToastApi {
  push(toast: Toast): void;
  clear(): void;
}

export function mountToast(): ToastApi {
  const container = document.createElement('div');
  container.id = 'toast-container';
  container.setAttribute('role', 'status');
  container.setAttribute('aria-live', 'polite');
  document.body.appendChild(container);

  const active: ActiveToast[] = [];

  function dismiss(entry: ActiveToast): void {
    const idx = active.indexOf(entry);
    if (idx < 0) {
      return;
    }
    active.splice(idx, 1);
    if (entry.timer) {
      window.clearTimeout(entry.timer);
    }
    entry.element.classList.add('toast-leaving');
    window.setTimeout(() => entry.element.remove(), 200);
  }

  function push(toast: Toast): void {
    // Suppress duplicate-in-a-row toasts (same kind + message).
    const last = active[active.length - 1];
    if (last && last.toast.kind === toast.kind && last.toast.message === toast.message) {
      return;
    }

    const node = document.createElement('div');
    node.className = `toast toast-${toast.kind}`;
    node.innerHTML = `
      <div class="toast-icon" aria-hidden="true">${iconFor(toast.kind)}</div>
      <div class="toast-body">
        <div class="toast-message"></div>
        ${toast.detail ? '<div class="toast-detail"></div>' : ''}
      </div>
      <button class="toast-close" aria-label="Dismiss">×</button>
    `;
    // Use textContent to avoid HTML injection from arbitrary diagnostic strings.
    node.querySelector('.toast-message')!.textContent = toast.message;
    if (toast.detail) {
      node.querySelector('.toast-detail')!.textContent = toast.detail;
    }

    const entry: ActiveToast = { toast, element: node };
    node.querySelector('.toast-close')!.addEventListener('click', () => dismiss(entry));

    const duration = toast.durationMs ?? DEFAULT_DURATIONS[toast.kind];
    if (duration > 0) {
      entry.timer = window.setTimeout(() => dismiss(entry), duration);
    }

    container.appendChild(node);
    active.push(entry);

    // Trigger entrance animation on next frame.
    requestAnimationFrame(() => node.classList.add('toast-entered'));
  }

  function clear(): void {
    for (const entry of [...active]) {
      dismiss(entry);
    }
  }

  return { push, clear };
}

function iconFor(kind: ToastKind): string {
  if (kind === 'error') {
    return '<svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L1 21h22L12 2zm0 7v5m0 3v.01" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>';
  }
  if (kind === 'warning') {
    return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><circle cx="12" cy="16" r="0.5" fill="currentColor"/></svg>';
  }
  return '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><circle cx="12" cy="8" r="0.5" fill="currentColor"/></svg>';
}

// Live preview helper: debounce editor changes so we don't re-parse
// (and re-build the 3D scene) on every keystroke.

export interface LivePreviewOptions {
  /** Debounce in ms — typical 150ms is invisible to humans but cuts CPU. */
  debounceMs?: number;
  /** Maximum-allowed debounce (used when the model is big). */
  maxDebounceMs?: number;
  /** Function called with the latest text after the debounce settles. */
  apply: (text: string) => void;
  /** Optional callback when a preview is pending (UI can show a spinner). */
  onPending?: (pending: boolean) => void;
}

export interface LivePreviewHandle {
  notify(text: string): void;
  setDebounce(ms: number): void;
  flush(): void;
  dispose(): void;
}

export function createLivePreview(options: LivePreviewOptions): LivePreviewHandle {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let latest: string | undefined;
  let debounceMs = options.debounceMs ?? 150;
  const maxDebounceMs = options.maxDebounceMs ?? 600;

  function trigger(): void {
    timer = undefined;
    if (latest === undefined) return;
    const text = latest;
    latest = undefined;
    options.onPending?.(false);
    options.apply(text);
  }

  return {
    notify(text) {
      latest = text;
      options.onPending?.(true);
      if (timer) clearTimeout(timer);
      timer = setTimeout(trigger, Math.min(debounceMs, maxDebounceMs));
    },
    setDebounce(ms) {
      debounceMs = Math.max(0, ms);
    },
    flush() {
      if (timer) {
        clearTimeout(timer);
        trigger();
      }
    },
    dispose() {
      if (timer) clearTimeout(timer);
      latest = undefined;
    }
  };
}

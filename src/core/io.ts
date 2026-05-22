// Core IO abstraction. The same core modules are reused by:
//   1. The VS Code extension host (src/extension.ts) — Node fs + jsdom.
//   2. The browser web app (src/web/main.ts) — File System Access API + native DOMParser.
// Each entry point installs its own implementation via setCoreIo() before
// invoking any core API. We never import node-only modules from core/*; the
// platform-specific glue (io.node.ts / web/ioBrowser.ts) does that.

export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

export interface CoreIo {
  readText(absPath: string): Promise<string>;
  /** Synchronous text read. Used by xacro's load_yaml expression. Browser impls
   *  should pre-populate a cache and return cached bytes; if missing, throw. */
  readTextSync(absPath: string): string;
  /** Best-effort sync existence check. Browser impls back this with a path index
   *  built during directory scan; if unknown, return false. */
  existsSync(absPath: string): boolean;
  readdir(absPath: string): Promise<DirEntry[]>;

  // Path utilities — must mirror node:path semantics for the platform.
  dirname(p: string): string;
  basename(p: string, ext?: string): string;
  extname(p: string): string;
  resolve(...parts: string[]): string;
  join(...parts: string[]): string;
  isAbsolute(p: string): boolean;
  readonly sep: string;

  // DOM access for xacro expansion. Node side wires jsdom; browser side wires
  // the native window DOM.
  readonly DOMParser: { new (): DOMParser };
  readonly XMLSerializer: { new (): XMLSerializer };
}

let current: CoreIo | null = null;

export function setCoreIo(io: CoreIo): void {
  current = io;
}

export function getCoreIo(): CoreIo {
  if (!current) {
    throw new Error('Core IO not configured. Import core/io.node or core/io.browser before using core APIs.');
  }
  return current;
}

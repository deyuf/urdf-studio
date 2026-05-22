export interface DirEntry {
  name: string;
  isDirectory: boolean;
}

export interface BrowserVfs {
  /** Display name shown in the UI. */
  readonly label: string;
  /** Absolute root path (POSIX, with leading "/"). */
  readonly root: string;

  readText(absPath: string): Promise<string>;
  readBytes(absPath: string): Promise<Uint8Array>;

  /** Synchronous text read from a pre-warmed cache. Throws on miss. */
  readTextSync(absPath: string): string;
  /** Synchronous existence lookup against the indexed tree. */
  existsSync(absPath: string): boolean;

  readdir(absPath: string): Promise<DirEntry[]>;

  /** Eagerly populate the readTextSync cache. */
  warmTextCache(absPaths: string[]): Promise<void>;

  /** Return a transient URL the browser can fetch. Cached within the current
   *  generation. Revoked when the generation containing it is committed away. */
  getBlobUrl(absPath: string): Promise<string>;

  /** Mark the start of a new load. The previous generation (if any uncommitted
   *  one is still around from a load that never completed) is revoked first;
   *  the current generation moves to "previous" and a fresh "current" begins.
   *  Two generations are kept alive simultaneously so in-flight asset fetches
   *  initiated against the prior load can finish without 404s. */
  beginGeneration(): void;

  /** Mark the current load as fully consumed by the renderer. The previous
   *  generation is revoked here, with any URLs reused by the current generation
   *  preserved (we promote URLs across generations to avoid revoke/recreate
   *  churn when consecutive loads share meshes). */
  commitGeneration(): void;

  /** Revoke every blob URL across all generations. Used on dispose. */
  releaseBlobs(): void;

  /** Enumerate every indexed file path (used by the file picker). */
  allFiles(): string[];

  /** Free all native handles and revoke blobs. */
  dispose(): void;
}

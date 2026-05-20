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

  /** Return a transient URL the browser can fetch. Cached until releaseBlobs(). */
  getBlobUrl(absPath: string): Promise<string>;

  /** Drop and revoke every blob URL handed out so far. */
  releaseBlobs(): void;

  /** Enumerate every indexed file path (used by the file picker). */
  allFiles(): string[];

  /** Free all native handles and revoke blobs. */
  dispose(): void;
}

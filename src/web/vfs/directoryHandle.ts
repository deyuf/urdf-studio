// File System Access API backed VFS. Scans the chosen directory once at start
// to build a flat path index for sync lookups; reads file bytes lazily.

import { posixPath } from './posixPath';
import type { BrowserVfs, DirEntry } from './types';

const SKIP_DIRS = new Set([
  '.git',
  '.hg',
  '.svn',
  'node_modules',
  'dist',
  'out',
  'build',
  'install',
  'log',
  '.cache',
  '.pytest_cache'
]);

interface IndexedFile {
  handle: FileSystemFileHandle;
}

interface IndexedDir {
  handle: FileSystemDirectoryHandle;
  children: Map<string, IndexedFile | IndexedDir>;
}

function isFileEntry(entry: IndexedFile | IndexedDir): entry is IndexedFile {
  return (entry as IndexedFile).handle?.kind === 'file';
}

export interface ScanOptions {
  onProgress?(fileCount: number, dirCount: number): void;
  signal?: AbortSignal;
}

export class DirectoryHandleVfs implements BrowserVfs {
  readonly label: string;
  readonly root: string;

  private readonly files = new Map<string, IndexedFile>();
  private readonly dirs = new Map<string, IndexedDir>();
  private readonly textCache = new Map<string, string>();
  private readonly blobUrls = new Map<string, string>();

  private constructor(rootHandle: FileSystemDirectoryHandle, rootPath: string) {
    this.label = rootHandle.name;
    this.root = rootPath;
  }

  static async create(rootHandle: FileSystemDirectoryHandle, options: ScanOptions = {}): Promise<DirectoryHandleVfs> {
    const root = `/${rootHandle.name}`;
    const vfs = new DirectoryHandleVfs(rootHandle, root);
    const rootDir: IndexedDir = { handle: rootHandle, children: new Map() };
    vfs.dirs.set(root, rootDir);
    await vfs.scan(rootHandle, root, rootDir, options);
    return vfs;
  }

  private async scan(handle: FileSystemDirectoryHandle, currentPath: string, parent: IndexedDir, options: ScanOptions): Promise<void> {
    let fileCount = this.files.size;
    let dirCount = this.dirs.size;
    let progressTick = 0;
    const stack: Array<{ handle: FileSystemDirectoryHandle; path: string; parent: IndexedDir }> = [
      { handle, path: currentPath, parent }
    ];

    while (stack.length > 0) {
      if (options.signal?.aborted) {
        throw new DOMException('Directory scan cancelled', 'AbortError');
      }
      const frame = stack.pop()!;
      for await (const [name, entry] of frame.handle.entries()) {
        if (entry.kind === 'directory' && SKIP_DIRS.has(name)) {
          continue;
        }
        const childPath = posixPath.join(frame.path, name);
        if (entry.kind === 'file') {
          const fileEntry: IndexedFile = { handle: entry };
          this.files.set(childPath, fileEntry);
          frame.parent.children.set(name, fileEntry);
          fileCount++;
        } else {
          const dirEntry: IndexedDir = { handle: entry, children: new Map() };
          this.dirs.set(childPath, dirEntry);
          frame.parent.children.set(name, dirEntry);
          dirCount++;
          stack.push({ handle: entry, path: childPath, parent: dirEntry });
        }
        progressTick++;
        if (options.onProgress && progressTick % 64 === 0) {
          options.onProgress(fileCount, dirCount);
          // Yield to the event loop so the UI can repaint during big scans.
          await new Promise<void>(resolve => setTimeout(resolve, 0));
        }
      }
    }
    options.onProgress?.(fileCount, dirCount);
  }

  existsSync(absPath: string): boolean {
    return this.files.has(absPath) || this.dirs.has(absPath);
  }

  async readText(absPath: string): Promise<string> {
    const cached = this.textCache.get(absPath);
    if (cached !== undefined) {
      return cached;
    }
    const file = await this.getFile(absPath);
    const text = await file.text();
    this.textCache.set(absPath, text);
    return text;
  }

  async readBytes(absPath: string): Promise<Uint8Array> {
    const file = await this.getFile(absPath);
    return new Uint8Array(await file.arrayBuffer());
  }

  readTextSync(absPath: string): string {
    const cached = this.textCache.get(absPath);
    if (cached === undefined) {
      throw new Error(`readTextSync miss: ${absPath}. Call warmTextCache() first.`);
    }
    return cached;
  }

  async warmTextCache(absPaths: string[]): Promise<void> {
    const unique = Array.from(new Set(absPaths));
    await Promise.all(unique.map(async p => {
      if (this.textCache.has(p)) {
        return;
      }
      try {
        const text = await (await this.getFile(p)).text();
        this.textCache.set(p, text);
      } catch {
        // missing files are surfaced later by readTextSync throwing.
      }
    }));
  }

  async readdir(absPath: string): Promise<DirEntry[]> {
    const dir = this.dirs.get(absPath);
    if (!dir) {
      throw new Error(`Not a directory: ${absPath}`);
    }
    const entries: DirEntry[] = [];
    for (const [name, child] of dir.children) {
      entries.push({ name, isDirectory: !isFileEntry(child) });
    }
    return entries;
  }

  async getBlobUrl(absPath: string): Promise<string> {
    const cached = this.blobUrls.get(absPath);
    if (cached) {
      return cached;
    }
    const file = await this.getFile(absPath);
    const url = URL.createObjectURL(file);
    this.blobUrls.set(absPath, url);
    return url;
  }

  releaseBlobs(): void {
    for (const url of this.blobUrls.values()) {
      URL.revokeObjectURL(url);
    }
    this.blobUrls.clear();
  }

  allFiles(): string[] {
    return Array.from(this.files.keys()).sort();
  }

  dispose(): void {
    this.releaseBlobs();
    this.files.clear();
    this.dirs.clear();
    this.textCache.clear();
  }

  private async getFile(absPath: string): Promise<File> {
    const entry = this.files.get(absPath);
    if (!entry) {
      throw new Error(`File not found in VFS: ${absPath}`);
    }
    return entry.handle.getFile();
  }
}

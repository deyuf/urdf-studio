// Fallback VFS for browsers without File System Access API (Safari, mobile).
// Built from a FileList obtained via <input type="file" webkitdirectory>.

import { posixPath } from './posixPath';
import type { BrowserVfs, DirEntry } from './types';

const SKIP_DIR_REGEX = /(^|\/)(\.git|\.hg|\.svn|node_modules|dist|out|build|install|log|\.cache|\.pytest_cache)(\/|$)/;

interface FileNode {
  kind: 'file';
  file: File;
}

interface DirNode {
  kind: 'dir';
  children: Map<string, FileNode | DirNode>;
}

export class FileListVfs implements BrowserVfs {
  readonly label: string;
  readonly root: string;

  private readonly tree: DirNode = { kind: 'dir', children: new Map() };
  private readonly files = new Map<string, File>();
  private readonly textCache = new Map<string, string>();
  private readonly blobUrls = new Map<string, string>();

  constructor(files: FileList | File[]) {
    const list = files instanceof FileList ? Array.from(files) : files;
    if (list.length === 0) {
      throw new Error('FileListVfs: empty file list');
    }
    const firstPath = (list[0] as File & { webkitRelativePath?: string }).webkitRelativePath ?? list[0].name;
    const rootName = firstPath.includes('/') ? firstPath.split('/')[0] : 'files';
    this.label = rootName;
    this.root = `/${rootName}`;
    for (const file of list) {
      const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
      if (SKIP_DIR_REGEX.test(`/${rel}`)) {
        continue;
      }
      const absPath = `/${rel}`;
      this.files.set(absPath, file);
      this.insertNode(absPath, file);
    }
  }

  private insertNode(absPath: string, file: File): void {
    const parts = absPath.split('/').filter(Boolean);
    let cursor: DirNode = this.tree;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i];
      let next = cursor.children.get(part);
      if (!next) {
        next = { kind: 'dir', children: new Map() } as DirNode;
        cursor.children.set(part, next);
      }
      if (next.kind !== 'dir') {
        return;
      }
      cursor = next;
    }
    cursor.children.set(parts[parts.length - 1], { kind: 'file', file });
  }

  private findNode(absPath: string): FileNode | DirNode | undefined {
    if (absPath === '/' || absPath === '') {
      return this.tree;
    }
    const parts = absPath.split('/').filter(Boolean);
    let cursor: FileNode | DirNode = this.tree;
    for (const part of parts) {
      if (cursor.kind !== 'dir') {
        return undefined;
      }
      const next = cursor.children.get(part);
      if (!next) {
        return undefined;
      }
      cursor = next;
    }
    return cursor;
  }

  existsSync(absPath: string): boolean {
    return this.findNode(absPath) !== undefined;
  }

  async readText(absPath: string): Promise<string> {
    const cached = this.textCache.get(absPath);
    if (cached !== undefined) {
      return cached;
    }
    const file = this.requireFile(absPath);
    const text = await file.text();
    this.textCache.set(absPath, text);
    return text;
  }

  async readBytes(absPath: string): Promise<Uint8Array> {
    const file = this.requireFile(absPath);
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
    await Promise.all(Array.from(new Set(absPaths)).map(async p => {
      if (this.textCache.has(p)) {
        return;
      }
      const file = this.files.get(p);
      if (!file) {
        return;
      }
      this.textCache.set(p, await file.text());
    }));
  }

  async readdir(absPath: string): Promise<DirEntry[]> {
    const node = this.findNode(absPath);
    if (!node || node.kind !== 'dir') {
      throw new Error(`Not a directory: ${absPath}`);
    }
    const out: DirEntry[] = [];
    for (const [name, child] of node.children) {
      out.push({ name, isDirectory: child.kind === 'dir' });
    }
    return out;
  }

  async getBlobUrl(absPath: string): Promise<string> {
    const cached = this.blobUrls.get(absPath);
    if (cached) {
      return cached;
    }
    const file = this.requireFile(absPath);
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
    this.textCache.clear();
    this.tree.children.clear();
  }

  private requireFile(absPath: string): File {
    const file = this.files.get(absPath);
    if (!file) {
      throw new Error(`File not found in VFS: ${absPath}`);
    }
    return file;
  }
}

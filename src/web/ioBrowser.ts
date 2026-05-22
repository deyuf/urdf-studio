// Browser CoreIo implementation. Delegates fs work to the active BrowserVfs.

import { setCoreIo, type CoreIo } from '../core/io';
import { posixPath } from './vfs/posixPath';
import type { BrowserVfs } from './vfs/types';

let activeVfs: BrowserVfs | null = null;

export function setActiveVfs(vfs: BrowserVfs | null): void {
  activeVfs = vfs;
}

export function requireActiveVfs(): BrowserVfs {
  if (!activeVfs) {
    throw new Error('No directory has been opened yet.');
  }
  return activeVfs;
}

export const browserCoreIo: CoreIo = {
  readText: p => requireActiveVfs().readText(p),
  readTextSync: p => requireActiveVfs().readTextSync(p),
  existsSync: p => (activeVfs ? activeVfs.existsSync(p) : false),
  readdir: p => requireActiveVfs().readdir(p),
  dirname: posixPath.dirname,
  basename: posixPath.basename,
  extname: posixPath.extname,
  resolve: posixPath.resolve,
  join: posixPath.join,
  isAbsolute: posixPath.isAbsolute,
  sep: posixPath.sep,
  DOMParser: globalThis.DOMParser,
  XMLSerializer: globalThis.XMLSerializer
};

setCoreIo(browserCoreIo);

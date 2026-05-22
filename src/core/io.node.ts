// Node-side CoreIo implementation. Side-effect import: requiring this module
// installs the implementation so subsequent core/* usage works.
import { promises as fs, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { JSDOM } from 'jsdom';
import { setCoreIo, type CoreIo } from './io';

const jsdomWindow = new JSDOM('<root/>', { contentType: 'text/xml' }).window;

export const nodeCoreIo: CoreIo = {
  readText: filePath => fs.readFile(filePath, 'utf8'),
  readTextSync: filePath => readFileSync(filePath, 'utf8'),
  existsSync,
  readdir: async dirPath => {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries.map(entry => ({ name: entry.name, isDirectory: entry.isDirectory() }));
  },
  dirname: path.dirname,
  basename: path.basename,
  extname: path.extname,
  resolve: path.resolve,
  join: path.join,
  isAbsolute: path.isAbsolute,
  sep: path.sep,
  DOMParser: jsdomWindow.DOMParser as unknown as { new (): DOMParser },
  XMLSerializer: jsdomWindow.XMLSerializer as unknown as { new (): XMLSerializer }
};

setCoreIo(nodeCoreIo);

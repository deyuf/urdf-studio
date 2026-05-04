import { promises as fs } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseXml } from './xml';
import type { PackageEntry, PackageMap } from './types';

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

export async function discoverPackages(roots: string[]): Promise<PackageMap> {
  const packages: PackageMap = {};
  const normalizedRoots = Array.from(new Set(roots.map(root => path.resolve(root))));

  for (const root of normalizedRoots) {
    await scanForPackages(root, packages);
  }

  return packages;
}

async function scanForPackages(root: string, packages: PackageMap): Promise<void> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return;
  }

  const packageXml = entries.find(entry => entry.isFile() && entry.name === 'package.xml');
  if (packageXml) {
    const packageXmlPath = path.join(root, packageXml.name);
    const name = await readPackageName(packageXmlPath);
    if (name && packages[name] === undefined) {
      packages[name] = {
        name,
        path: root,
        packageXml: packageXmlPath
      };
    }
  }

  await Promise.all(entries
    .filter(entry => entry.isDirectory() && !SKIP_DIRS.has(entry.name))
    .map(entry => scanForPackages(path.join(root, entry.name), packages)));
}

async function readPackageName(packageXmlPath: string): Promise<string | undefined> {
  try {
    const xml = await fs.readFile(packageXmlPath, 'utf8');
    const doc = parseXml(xml, packageXmlPath);
    return doc.getElementsByTagName('name').item(0)?.textContent?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function resolveModelUriToFile(filename: string, packages: PackageMap, documentDir: string): { resolvedPath?: string; packageName?: string } {
  if (filename.startsWith('package://')) {
    const rest = filename.slice('package://'.length);
    const slash = rest.indexOf('/');
    const packageName = slash >= 0 ? rest.slice(0, slash) : rest;
    const relativePath = slash >= 0 ? rest.slice(slash + 1) : '';
    const packageEntry = packages[packageName];
    return {
      packageName,
      resolvedPath: packageEntry ? path.join(packageEntry.path, relativePath) : undefined
    };
  }

  if (/^file:\/\//.test(filename)) {
    return { resolvedPath: new URL(filename).pathname };
  }

  if (/^[a-zA-Z]+:\/\//.test(filename)) {
    return {};
  }

  return {
    resolvedPath: path.isAbsolute(filename) ? filename : path.resolve(documentDir, filename)
  };
}

export function packageRootToUri(packagePath: string): string {
  return pathToFileURL(packagePath.endsWith(path.sep) ? packagePath : `${packagePath}${path.sep}`).toString();
}


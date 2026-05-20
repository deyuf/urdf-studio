import { parseXml } from './xml';
import { getCoreIo } from './io';
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
  const io = getCoreIo();
  const packages: PackageMap = {};
  const normalizedRoots = Array.from(new Set(roots.map(root => io.resolve(root))));

  for (const root of normalizedRoots) {
    await scanForPackages(root, packages);
  }

  return packages;
}

async function scanForPackages(root: string, packages: PackageMap): Promise<void> {
  const io = getCoreIo();
  let entries: Awaited<ReturnType<typeof io.readdir>>;
  try {
    entries = await io.readdir(root);
  } catch {
    return;
  }

  const packageXml = entries.find(entry => !entry.isDirectory && entry.name === 'package.xml');
  if (packageXml) {
    const packageXmlPath = io.join(root, packageXml.name);
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
    .filter(entry => entry.isDirectory && !SKIP_DIRS.has(entry.name))
    .map(entry => scanForPackages(io.join(root, entry.name), packages)));
}

async function readPackageName(packageXmlPath: string): Promise<string | undefined> {
  const io = getCoreIo();
  try {
    const xml = await io.readText(packageXmlPath);
    const doc = parseXml(xml, packageXmlPath);
    return doc.getElementsByTagName('name').item(0)?.textContent?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function resolveModelUriToFile(filename: string, packages: PackageMap, documentDir: string): { resolvedPath?: string; packageName?: string } {
  const io = getCoreIo();
  if (filename.startsWith('package://')) {
    const rest = filename.slice('package://'.length);
    const slash = rest.indexOf('/');
    const packageName = slash >= 0 ? rest.slice(0, slash) : rest;
    const relativePath = slash >= 0 ? rest.slice(slash + 1) : '';
    const packageEntry = packages[packageName];
    return {
      packageName,
      resolvedPath: packageEntry ? io.join(packageEntry.path, relativePath) : undefined
    };
  }

  if (/^file:\/\//.test(filename)) {
    return { resolvedPath: new URL(filename).pathname };
  }

  if (/^[a-zA-Z]+:\/\//.test(filename)) {
    return {};
  }

  return {
    resolvedPath: io.isAbsolute(filename) ? filename : io.resolve(documentDir, filename)
  };
}

export function packageRootToUri(packagePath: string): string {
  const io = getCoreIo();
  const normalized = packagePath.endsWith(io.sep) ? packagePath : `${packagePath}${io.sep}`;
  // pathToFileURL equivalent using URL constructor — works for absolute posix paths.
  return new URL(`file://${normalized.replace(/\\/g, '/')}`).toString();
}

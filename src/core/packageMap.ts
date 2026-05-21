import { parseXml } from './xml';
import { getCoreIo } from './io';
import type { PackageMap } from './types';

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

// Cap recursion depth so users opening a `~/` style root cannot accidentally
// grind the scanner through a deep filesystem. ROS workspaces normally have
// packages at depth 1-3 below the workspace root, so 16 is a generous upper
// bound while still preventing pathological scans.
export const MAX_PACKAGE_SCAN_DEPTH = 16;

// Maximum number of parent directories the package-resolver fallback will
// walk when locating a mesh referenced via `package://<unknown>/...`.
export const WALK_UP_LIMIT = 8;

export async function discoverPackages(roots: string[]): Promise<PackageMap> {
  const io = getCoreIo();
  const packages: PackageMap = {};
  const normalizedRoots = Array.from(new Set(roots.map(root => io.resolve(root))));

  for (const root of normalizedRoots) {
    await scanForPackages(root, packages, 0);
  }

  return packages;
}

async function scanForPackages(root: string, packages: PackageMap, depth: number): Promise<void> {
  if (depth > MAX_PACKAGE_SCAN_DEPTH) {
    return;
  }
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
    // Stop descending — ROS packages cannot legally nest other packages.
    // Skipping their contents drops scan time dramatically on workspaces
    // with many packages, each containing thousands of mesh files.
    return;
  }

  await Promise.all(entries
    .filter(entry => entry.isDirectory && !SKIP_DIRS.has(entry.name))
    .map(entry => scanForPackages(io.join(root, entry.name), packages, depth + 1)));
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

export interface ResolveResult {
  /** Absolute path to the resolved file, if anything matched. */
  resolvedPath?: string;
  /** The `<pkg>` portion of a `package://<pkg>/<rest>` URI, if applicable. */
  packageName?: string;
  /** True when the resolver had to fall back to ancestor-directory
   *  walking (the named package was not registered). */
  viaFallback?: boolean;
}

export function resolveModelUriToFile(filename: string, packages: PackageMap, documentDir: string): ResolveResult {
  const io = getCoreIo();
  if (filename.startsWith('package://')) {
    const rest = filename.slice('package://'.length);
    const slash = rest.indexOf('/');
    const packageName = slash >= 0 ? rest.slice(0, slash) : rest;
    const relativePath = slash >= 0 ? rest.slice(slash + 1) : '';
    const packageEntry = packages[packageName];
    if (packageEntry) {
      return {
        packageName,
        resolvedPath: io.join(packageEntry.path, relativePath)
      };
    }
    // Fallback: the named package is not registered (no package.xml found
    // in the workspace). Walk up from the URDF's directory looking for the
    // relative path. Catches the very common "I uploaded the package's
    // contents but not the package.xml" case — typical for users dropping
    // a ROS description folder into the web app.
    if (relativePath) {
      const fallback = findByWalkingUp(relativePath, documentDir, io);
      if (fallback) {
        return { packageName, resolvedPath: fallback, viaFallback: true };
      }
    }
    return { packageName };
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

function findByWalkingUp(relativePath: string, startDir: string, io: ReturnType<typeof getCoreIo>): string | undefined {
  let dir = startDir;
  for (let i = 0; i < WALK_UP_LIMIT; i++) {
    const candidate = io.resolve(dir, relativePath);
    if (io.existsSync(candidate)) {
      return candidate;
    }
    const parent = io.dirname(dir);
    if (parent === dir) {
      return undefined;
    }
    dir = parent;
  }
  return undefined;
}

export function packageRootToUri(packagePath: string): string {
  const io = getCoreIo();
  const normalized = packagePath.endsWith(io.sep) ? packagePath : `${packagePath}${io.sep}`;
  // pathToFileURL equivalent using URL constructor — works for absolute posix paths.
  return new URL(`file://${normalized.replace(/\\/g, '/')}`).toString();
}

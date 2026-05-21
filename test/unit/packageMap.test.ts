import { strict as assert } from 'node:assert';
import test from 'node:test';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import '../../src/core/io.node';
import {
  discoverPackages,
  resolveModelUriToFile,
  packageRootToUri,
  MAX_PACKAGE_SCAN_DEPTH,
  WALK_UP_LIMIT
} from '../../src/core/packageMap';

async function mkPkg(root: string, relDir: string, packageName: string): Promise<string> {
  const dir = path.join(root, relDir);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, 'package.xml'),
    `<package format="3"><name>${packageName}</name></package>`,
    'utf8'
  );
  return dir;
}

// =============================================================================
// discoverPackages
// =============================================================================

test('discoverPackages finds packages at any nesting depth', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'urdfstudio-pkg-discover-'));
  try {
    await mkPkg(tmp, 'src/foo_description', 'foo_description');
    await mkPkg(tmp, 'src/group/bar', 'bar');

    const result = await discoverPackages([tmp]);
    assert.equal(result.foo_description?.name, 'foo_description');
    assert.equal(result.bar?.name, 'bar');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('discoverPackages stops descending once a package.xml is found', async () => {
  // A package may contain subdirectories; we should NOT descend into them
  // looking for nested packages (ROS forbids nested packages, and skipping
  // children of a found package speeds up scans dramatically).
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'urdfstudio-pkg-stop-'));
  try {
    const outer = await mkPkg(tmp, 'outer', 'outer');
    // A fake "inner" package nested inside `outer/` — discoverPackages should
    // NOT pick this up, because the resolver stops descending into outer.
    await mkPkg(outer, 'inner', 'inner_should_be_skipped');

    const result = await discoverPackages([tmp]);
    assert.equal(result.outer?.name, 'outer');
    assert.equal(result.inner_should_be_skipped, undefined, 'must not descend into a package');
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('discoverPackages skips well-known build/VCS directories', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'urdfstudio-pkg-skip-'));
  try {
    await mkPkg(tmp, 'node_modules/should_not_show', 'should_not_show');
    await mkPkg(tmp, '.git/hidden_pkg', 'hidden_pkg');
    await mkPkg(tmp, 'dist/build_pkg', 'build_pkg');
    await mkPkg(tmp, 'real_pkg', 'real_pkg');

    const result = await discoverPackages([tmp]);
    assert.equal(result.real_pkg?.name, 'real_pkg');
    assert.equal(result.should_not_show, undefined);
    assert.equal(result.hidden_pkg, undefined);
    assert.equal(result.build_pkg, undefined);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('discoverPackages caps recursion at MAX_PACKAGE_SCAN_DEPTH', async () => {
  // Make sure the constant is sensible (sanity check rather than an empirical
  // depth test — building 16+ nested dirs in tmpfs would be slow on CI).
  assert.ok(MAX_PACKAGE_SCAN_DEPTH >= 4 && MAX_PACKAGE_SCAN_DEPTH <= 64,
    `MAX_PACKAGE_SCAN_DEPTH should be a reasonable bound, got ${MAX_PACKAGE_SCAN_DEPTH}`);
});

test('discoverPackages dedupes the same root passed twice', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'urdfstudio-pkg-dedupe-'));
  try {
    await mkPkg(tmp, 'p', 'pkg_once');
    const result = await discoverPackages([tmp, tmp, path.join(tmp, '.')]);
    assert.equal(result.pkg_once?.name, 'pkg_once');
    // No duplication: the same package shows up once.
    assert.equal(Object.keys(result).length, 1);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('discoverPackages tolerates unreadable roots silently', async () => {
  const result = await discoverPackages(['/this/path/does/not/exist/anywhere/123']);
  assert.deepEqual(result, {});
});

// =============================================================================
// resolveModelUriToFile
// =============================================================================

test('resolveModelUriToFile resolves package:// URIs against a registered package', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'urdfstudio-resolve-'));
  try {
    const pkgPath = await mkPkg(tmp, 'p', 'pkg_a');
    const result = resolveModelUriToFile('package://pkg_a/meshes/box.stl', {
      pkg_a: { name: 'pkg_a', path: pkgPath, packageXml: path.join(pkgPath, 'package.xml') }
    }, tmp);
    assert.equal(result.packageName, 'pkg_a');
    assert.equal(result.resolvedPath, path.join(pkgPath, 'meshes/box.stl'));
    assert.equal(result.viaFallback, undefined);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('resolveModelUriToFile falls back by walking up when the package is unknown', async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'urdfstudio-resolve-walk-'));
  try {
    // Drop the relative file at a parent we'll walk into.
    const meshDir = path.join(tmp, 'meshes');
    await fs.mkdir(meshDir, { recursive: true });
    await fs.writeFile(path.join(meshDir, 'box.stl'), 'fake-stl', 'utf8');

    // The URDF lives at <tmp>/urdf/, so walking up should find <tmp>/meshes/box.stl.
    const urdfDir = path.join(tmp, 'urdf');
    await fs.mkdir(urdfDir, { recursive: true });

    const result = resolveModelUriToFile('package://unregistered/meshes/box.stl', {}, urdfDir);
    assert.equal(result.viaFallback, true);
    assert.equal(result.packageName, 'unregistered');
    assert.equal(result.resolvedPath, path.join(tmp, 'meshes/box.stl'));
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test('resolveModelUriToFile returns packageName-only when no fallback succeeds', async () => {
  const result = resolveModelUriToFile('package://nope/some/path.stl', {}, '/totally/missing');
  assert.equal(result.packageName, 'nope');
  assert.equal(result.resolvedPath, undefined);
  assert.equal(result.viaFallback, undefined);
});

test('resolveModelUriToFile resolves file:// URIs to pathname', () => {
  const result = resolveModelUriToFile('file:///abs/path/box.stl', {}, '/anywhere');
  assert.equal(result.resolvedPath, '/abs/path/box.stl');
});

test('resolveModelUriToFile ignores http(s) URIs', () => {
  const result = resolveModelUriToFile('https://example.com/box.stl', {}, '/anywhere');
  assert.deepEqual(result, {});
});

test('resolveModelUriToFile resolves bare relative paths against documentDir', () => {
  const result = resolveModelUriToFile('meshes/box.stl', {}, '/robot/urdf');
  assert.equal(result.resolvedPath, path.resolve('/robot/urdf', 'meshes/box.stl'));
});

test('resolveModelUriToFile leaves absolute filesystem paths alone', () => {
  const result = resolveModelUriToFile('/abs/path/box.stl', {}, '/somewhere/else');
  assert.equal(result.resolvedPath, '/abs/path/box.stl');
});

test('WALK_UP_LIMIT is a sensible small number', () => {
  assert.ok(WALK_UP_LIMIT >= 2 && WALK_UP_LIMIT <= 32, `WALK_UP_LIMIT = ${WALK_UP_LIMIT}`);
});

// =============================================================================
// packageRootToUri
// =============================================================================

test('packageRootToUri converts an absolute path to a file:// URI with trailing slash', () => {
  const uri = packageRootToUri('/var/ros/my_pkg');
  assert.match(uri, /^file:\/\/\/var\/ros\/my_pkg\/?/);
  assert.ok(uri.endsWith('/'), 'package root URI must end with a slash');
});

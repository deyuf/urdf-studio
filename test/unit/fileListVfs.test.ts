import { strict as assert } from 'node:assert';
import test from 'node:test';
import { FileListVfs } from '../../src/web/vfs/fileList';

// File construction in Node 20+ matches the web's File interface, but
// FileListVfs reads `webkitRelativePath` to figure out the original folder
// layout. We attach it by hand to mirror what the browser would do.
function makeFile(relPath: string, content = ''): File {
  const f = new File([content], relPath.split('/').pop() ?? relPath);
  Object.defineProperty(f, 'webkitRelativePath', { value: relPath, configurable: true });
  return f;
}

test('FileListVfs builds an index from webkitRelativePath layout', async () => {
  const files = [
    makeFile('franka_description/urdf/fr3.urdf', '<robot/>'),
    makeFile('franka_description/meshes/link0.stl', 'stl-bytes'),
    makeFile('franka_description/package.xml', '<package><name>franka_description</name></package>')
  ];
  const vfs = new FileListVfs(files);

  assert.equal(vfs.root, '/franka_description');
  assert.equal(vfs.label, 'franka_description');
  assert.equal(vfs.existsSync('/franka_description/urdf/fr3.urdf'), true);
  assert.equal(vfs.existsSync('/franka_description/meshes/link0.stl'), true);
  assert.equal(vfs.existsSync('/franka_description/missing.stl'), false);
});

test('FileListVfs.readText caches text content on second access', async () => {
  let textReads = 0;
  const file = makeFile('pkg/urdf/r.urdf', '<robot name="r"/>');
  const original = file.text.bind(file);
  (file as any).text = async () => { // eslint-disable-line @typescript-eslint/no-explicit-any
    textReads += 1;
    return original();
  };
  const vfs = new FileListVfs([file]);
  const first = await vfs.readText('/pkg/urdf/r.urdf');
  const second = await vfs.readText('/pkg/urdf/r.urdf');
  assert.equal(first, '<robot name="r"/>');
  assert.equal(second, first);
  assert.equal(textReads, 1, 'second read should hit the cache');
});

test('FileListVfs.readTextSync throws when the file is not warm', async () => {
  const vfs = new FileListVfs([makeFile('pkg/a.txt', 'hi')]);
  assert.throws(() => vfs.readTextSync('/pkg/a.txt'), /readTextSync miss/);
});

test('FileListVfs.warmTextCache populates the sync cache for listed files', async () => {
  const vfs = new FileListVfs([makeFile('pkg/a.yaml', 'k: v')]);
  await vfs.warmTextCache(['/pkg/a.yaml']);
  assert.equal(vfs.readTextSync('/pkg/a.yaml'), 'k: v');
});

test('FileListVfs.warmTextCache silently skips missing paths', async () => {
  const vfs = new FileListVfs([makeFile('pkg/a.yaml', 'k: v')]);
  await vfs.warmTextCache(['/pkg/a.yaml', '/pkg/missing.yaml']);
  // Sync read of the present file works; missing ones still throw later.
  assert.equal(vfs.readTextSync('/pkg/a.yaml'), 'k: v');
  assert.throws(() => vfs.readTextSync('/pkg/missing.yaml'));
});

test('FileListVfs.readdir returns entries with directory flags', async () => {
  const vfs = new FileListVfs([
    makeFile('pkg/urdf/a.urdf', ''),
    makeFile('pkg/urdf/b.urdf', ''),
    makeFile('pkg/meshes/box.stl', ''),
    makeFile('pkg/package.xml', '')
  ]);
  const root = await vfs.readdir('/pkg');
  const names = root.map(entry => entry.name).sort();
  assert.deepEqual(names, ['meshes', 'package.xml', 'urdf']);
  const urdf = root.find(e => e.name === 'urdf')!;
  const pkgXml = root.find(e => e.name === 'package.xml')!;
  assert.equal(urdf.isDirectory, true);
  assert.equal(pkgXml.isDirectory, false);
});

test('FileListVfs.readdir throws for unknown directories', async () => {
  const vfs = new FileListVfs([makeFile('pkg/a.txt', '')]);
  await assert.rejects(() => vfs.readdir('/pkg/nonexistent'), /Not a directory/);
});

test('FileListVfs.allFiles returns every indexed absolute path, sorted', () => {
  const vfs = new FileListVfs([
    makeFile('pkg/z.txt', ''),
    makeFile('pkg/a.txt', ''),
    makeFile('pkg/m/x.txt', '')
  ]);
  assert.deepEqual(vfs.allFiles(), ['/pkg/a.txt', '/pkg/m/x.txt', '/pkg/z.txt']);
});

test('FileListVfs skips SKIP_DIRS in the indexed layout', () => {
  const vfs = new FileListVfs([
    makeFile('pkg/.git/HEAD', ''),
    makeFile('pkg/node_modules/dep/index.js', ''),
    makeFile('pkg/urdf/robot.urdf', '')
  ]);
  assert.equal(vfs.existsSync('/pkg/urdf/robot.urdf'), true);
  assert.equal(vfs.existsSync('/pkg/.git/HEAD'), false);
  assert.equal(vfs.existsSync('/pkg/node_modules/dep/index.js'), false);
});

// =============================================================================
// Blob URL two-generation lifecycle
// =============================================================================

test('FileListVfs blob URLs carry over across generations when path is reused', async () => {
  const createdUrls: string[] = [];
  const revokedUrls: string[] = [];
  const fakeUrlGlobal: { createObjectURL: typeof URL.createObjectURL; revokeObjectURL: typeof URL.revokeObjectURL } = {
    createObjectURL: (_blob: Blob) => {
      const u = `blob:fake-${createdUrls.length}`;
      createdUrls.push(u);
      return u;
    },
    revokeObjectURL: (u: string) => { revokedUrls.push(u); }
  };
  const originalUrl = globalThis.URL;
  const stubUrl = { ...originalUrl, createObjectURL: fakeUrlGlobal.createObjectURL, revokeObjectURL: fakeUrlGlobal.revokeObjectURL };
  (globalThis as { URL: typeof URL }).URL = stubUrl as typeof URL;
  try {
    const vfs = new FileListVfs([makeFile('pkg/m/a.stl', 'a'), makeFile('pkg/m/b.stl', 'b')]);

    const aUrl1 = await vfs.getBlobUrl('/pkg/m/a.stl');
    const bUrl1 = await vfs.getBlobUrl('/pkg/m/b.stl');
    assert.equal(createdUrls.length, 2);
    assert.equal(revokedUrls.length, 0);

    // Start a new generation: previous URLs move into the "previous" map.
    vfs.beginGeneration();
    assert.equal(revokedUrls.length, 0, 'previous URLs not revoked until commit');

    // a.stl reused → carry over; b.stl not reused.
    const aUrl2 = await vfs.getBlobUrl('/pkg/m/a.stl');
    assert.equal(aUrl2, aUrl1, 'reused mesh keeps its blob URL');
    assert.equal(createdUrls.length, 2, 'no new URL minted for the reused mesh');

    // Commit: b.stl's URL is revoked, a.stl's URL stays alive.
    vfs.commitGeneration();
    assert.deepEqual(revokedUrls, [bUrl1]);
  } finally {
    (globalThis as { URL: typeof URL }).URL = originalUrl;
  }
});

test('FileListVfs.beginGeneration revokes orphaned URLs from a prior aborted load', async () => {
  const revoked: string[] = [];
  const originalUrl = globalThis.URL;
  let counter = 0;
  const stub = {
    ...originalUrl,
    createObjectURL: (_blob: Blob) => `blob:fake-${counter++}`,
    revokeObjectURL: (u: string) => { revoked.push(u); }
  };
  (globalThis as { URL: typeof URL }).URL = stub as typeof URL;
  try {
    const vfs = new FileListVfs([makeFile('pkg/a.stl', 'a')]);
    await vfs.getBlobUrl('/pkg/a.stl');
    vfs.beginGeneration(); // current → previous; no carry yet
    vfs.beginGeneration(); // previous never committed; should be revoked here
    assert.equal(revoked.length, 1, 'orphan from two-generations-ago must be revoked');
  } finally {
    (globalThis as { URL: typeof URL }).URL = originalUrl;
  }
});

test('FileListVfs.releaseBlobs revokes everything tracked across both generations', async () => {
  const revoked: string[] = [];
  const originalUrl = globalThis.URL;
  let counter = 0;
  const stub = {
    ...originalUrl,
    createObjectURL: (_blob: Blob) => `blob:fake-${counter++}`,
    revokeObjectURL: (u: string) => { revoked.push(u); }
  };
  (globalThis as { URL: typeof URL }).URL = stub as typeof URL;
  try {
    const vfs = new FileListVfs([makeFile('pkg/a.stl', 'a'), makeFile('pkg/b.stl', 'b')]);
    await vfs.getBlobUrl('/pkg/a.stl');
    vfs.beginGeneration();
    await vfs.getBlobUrl('/pkg/b.stl');
    vfs.releaseBlobs();
    assert.equal(revoked.length, 2, `expected both URLs revoked, revoked=${JSON.stringify(revoked)}`);
  } finally {
    (globalThis as { URL: typeof URL }).URL = originalUrl;
  }
});

test('FileListVfs throws on construction with an empty file list', () => {
  assert.throws(() => new FileListVfs([] as unknown as File[]), /empty file list/);
});

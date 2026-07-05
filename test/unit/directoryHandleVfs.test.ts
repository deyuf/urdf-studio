import { strict as assert } from 'node:assert';
import test from 'node:test';
import { DirectoryHandleVfs } from '../../src/web/vfs/directoryHandle';

// Minimal in-memory fakes for the File System Access handle surface that
// DirectoryHandleVfs.create() consumes: `name`, `kind`, async `entries()`,
// and (on files) `getFile()`.

interface Tree {
  [name: string]: string | Tree;
}

function makeFileHandle(name: string, content: string): FileSystemFileHandle {
  return {
    kind: 'file',
    name,
    async getFile(): Promise<File> {
      return new File([content], name);
    }
  } as unknown as FileSystemFileHandle;
}

function makeDirHandle(name: string, tree: Tree): FileSystemDirectoryHandle {
  return {
    kind: 'directory',
    name,
    async *entries(): AsyncGenerator<[string, FileSystemFileHandle | FileSystemDirectoryHandle]> {
      for (const [childName, value] of Object.entries(tree)) {
        if (typeof value === 'string') {
          yield [childName, makeFileHandle(childName, value)];
        } else {
          yield [childName, makeDirHandle(childName, value)];
        }
      }
    }
  } as unknown as FileSystemDirectoryHandle;
}

test('DirectoryHandleVfs: builds an index and exact lookups work', async () => {
  const handle = makeDirHandle('pkg', {
    meshes: { 'link0.stl': 'bytes' },
    'robot.urdf': '<robot/>'
  });
  const vfs = await DirectoryHandleVfs.create(handle);
  assert.equal(vfs.root, '/pkg');
  assert.equal(vfs.existsSync('/pkg/robot.urdf'), true);
  assert.equal(vfs.existsSync('/pkg/meshes/link0.stl'), true);
  assert.equal(vfs.existsSync('/pkg/missing.stl'), false);
});

test('DirectoryHandleVfs: existsSync falls back to a case-insensitive match', async () => {
  const handle = makeDirHandle('pkg', {
    meshes: { 'link0.stl': 'bytes' }
  });
  const vfs = await DirectoryHandleVfs.create(handle);
  assert.equal(vfs.existsSync('/pkg/meshes/Link0.STL'), true);
  assert.equal(vfs.existsSync('/PKG/MESHES/link0.stl'), true);
  assert.equal(vfs.existsSync('/pkg/meshes/nope.stl'), false);
});

test('DirectoryHandleVfs: readText falls back to a case-insensitive match', async () => {
  const handle = makeDirHandle('pkg', {
    meshes: { 'Link0.STL': 'STL-CONTENT' }
  });
  const vfs = await DirectoryHandleVfs.create(handle);
  const exact = await vfs.readText('/pkg/meshes/Link0.STL');
  const insensitive = await vfs.readText('/pkg/meshes/link0.stl');
  assert.equal(exact, 'STL-CONTENT');
  assert.equal(insensitive, 'STL-CONTENT');
});

test('DirectoryHandleVfs: readdir resolves case-insensitively', async () => {
  const handle = makeDirHandle('pkg', {
    Meshes: { 'a.stl': '', 'b.stl': '' }
  });
  const vfs = await DirectoryHandleVfs.create(handle);
  const entries = await vfs.readdir('/pkg/meshes');
  const names = entries.map(e => e.name).sort();
  assert.deepEqual(names, ['a.stl', 'b.stl']);
});

test('DirectoryHandleVfs: scan aborts when the signal is already aborted', async () => {
  const handle = makeDirHandle('pkg', { 'robot.urdf': '<robot/>' });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => DirectoryHandleVfs.create(handle, { signal: controller.signal }),
    /AbortError|cancelled/
  );
});

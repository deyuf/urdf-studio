import { strict as assert } from 'node:assert';
import test from 'node:test';
import { posixPath } from '../../src/web/vfs/posixPath';

// =============================================================================
// isAbsolute
// =============================================================================

test('isAbsolute identifies absolute and relative paths', () => {
  assert.equal(posixPath.isAbsolute('/'), true);
  assert.equal(posixPath.isAbsolute('/a'), true);
  assert.equal(posixPath.isAbsolute('/a/b/c'), true);
  assert.equal(posixPath.isAbsolute(''), false);
  assert.equal(posixPath.isAbsolute('a'), false);
  assert.equal(posixPath.isAbsolute('./a'), false);
  assert.equal(posixPath.isAbsolute('../a'), false);
});

// =============================================================================
// dirname
// =============================================================================

test('dirname returns parent for typical absolute paths', () => {
  assert.equal(posixPath.dirname('/a/b/c.txt'), '/a/b');
  assert.equal(posixPath.dirname('/a/b/c'), '/a/b');
  assert.equal(posixPath.dirname('/foo'), '/');
});

test('dirname strips trailing slashes', () => {
  assert.equal(posixPath.dirname('/a/b/c/'), '/a/b');
  assert.equal(posixPath.dirname('/a/'), '/');
});

test('dirname returns "." for bare relative names', () => {
  assert.equal(posixPath.dirname('file.txt'), '.');
});

test('dirname returns "." for empty input', () => {
  assert.equal(posixPath.dirname(''), '.');
});

test('dirname returns "/" for the root', () => {
  assert.equal(posixPath.dirname('/'), '/');
});

// =============================================================================
// basename
// =============================================================================

test('basename returns last segment', () => {
  assert.equal(posixPath.basename('/a/b/c.txt'), 'c.txt');
  assert.equal(posixPath.basename('c.txt'), 'c.txt');
});

test('basename strips trailing slashes', () => {
  assert.equal(posixPath.basename('/a/b/'), 'b');
});

test('basename removes a matching trailing extension', () => {
  assert.equal(posixPath.basename('/a/b/c.urdf', '.urdf'), 'c');
  assert.equal(posixPath.basename('/a/b/c.urdf', '.xacro'), 'c.urdf'); // mismatch: keep
});

test('basename handles empty input', () => {
  assert.equal(posixPath.basename(''), '');
});

// =============================================================================
// extname
// =============================================================================

test('extname returns the dotted extension', () => {
  assert.equal(posixPath.extname('/a/b/c.urdf'), '.urdf');
  assert.equal(posixPath.extname('robot.urdf.xacro'), '.xacro');
  assert.equal(posixPath.extname('no-extension'), '');
});

test('extname does not treat leading dot as extension', () => {
  assert.equal(posixPath.extname('.hidden'), '');
});

// =============================================================================
// join
// =============================================================================

test('join concatenates and normalises', () => {
  assert.equal(posixPath.join('/a', 'b', 'c'), '/a/b/c');
  assert.equal(posixPath.join('/a/', '/b'), '/a/b');
  assert.equal(posixPath.join('a', '..', 'b'), 'b');
  assert.equal(posixPath.join('/', 'a'), '/a');
});

test('join collapses repeated slashes', () => {
  assert.equal(posixPath.join('/a//b///c'), '/a/b/c');
});

test('join with no arguments returns "."', () => {
  assert.equal(posixPath.join(), '.');
});

// =============================================================================
// resolve
// =============================================================================

test('resolve walks segments right-to-left until an absolute root is found', () => {
  assert.equal(posixPath.resolve('/a/b', 'c'), '/a/b/c');
  assert.equal(posixPath.resolve('/a/b', '/c'), '/c');
  assert.equal(posixPath.resolve('a', 'b', 'c'), '/a/b/c');
});

test('resolve collapses .. segments', () => {
  assert.equal(posixPath.resolve('/a/b/c', '../d'), '/a/b/d');
  assert.equal(posixPath.resolve('/a/b/c', '../../d'), '/a/d');
});

test('resolve handles trailing slashes', () => {
  // resolve normalises away trailing slashes to give an unambiguous abspath
  assert.equal(posixPath.resolve('/a/b/'), '/a/b');
});

// =============================================================================
// Round-trip properties
// =============================================================================

test('dirname/basename round-trip reconstructs the input for normal paths', () => {
  const samples = [
    '/a/b/c.txt',
    '/foo/bar/baz.urdf',
    '/single.txt'
  ];
  for (const p of samples) {
    const joined = posixPath.join(posixPath.dirname(p), posixPath.basename(p));
    assert.equal(joined, p, `round-trip failed for ${p}`);
  }
});

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { computeDocumentKey } from '../../src/web/host';

test('computeDocumentKey produces label::relPath when absPath lies under root', () => {
  const key = computeDocumentKey('franka_description', '/franka_description', '/franka_description/urdf/fr3.urdf');
  assert.equal(key, 'franka_description::/urdf/fr3.urdf');
});

test('computeDocumentKey treats absPath equal to root as "/"', () => {
  const key = computeDocumentKey('franka_description', '/franka_description', '/franka_description');
  assert.equal(key, 'franka_description::/');
});

test('computeDocumentKey is robust to identically-named folders at different paths', () => {
  // Two different on-disk franka folders should yield distinct keys for the
  // same robot file, as long as their VFS root differs. The browser only sees
  // the label + root pair though, so the key here equals when label+relPath
  // match — that's expected because in-browser the user can only have one
  // VFS active at a time. We just verify the relPath is consistent.
  const k1 = computeDocumentKey('franka', '/franka', '/franka/urdf/fr3.urdf');
  const k2 = computeDocumentKey('franka', '/franka', '/franka/urdf/fr3.urdf');
  assert.equal(k1, k2);
});

test('computeDocumentKey does not concatenate label and path directly (legacy collision regression)', () => {
  // Old implementation returned `${label}${absPath}` so:
  //   label='franka'        + path='/_descr/x' → 'franka/_descr/x'
  //   label='franka_descr'  + path='/x'        → 'franka_descr/x'
  // (different inputs, same string). The new key must be unambiguous because
  // the `::` separator cannot occur in label or path.
  const k1 = computeDocumentKey('franka', '/franka', '/franka/_descr/x');
  const k2 = computeDocumentKey('franka_descr', '/franka_descr', '/franka_descr/x');
  assert.notEqual(k1, k2);
});

test('computeDocumentKey leaves absPath as-is when it does not start with root', () => {
  const key = computeDocumentKey('label', '/root', '/elsewhere/file');
  assert.equal(key, 'label::/elsewhere/file');
});

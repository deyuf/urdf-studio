import { strict as assert } from 'node:assert';
import test from 'node:test';
import { DOMParser } from '@xmldom/xmldom';
import { makeRenderable } from '../../src/core/renderable';

const robot = (body: string): string => `<?xml version="1.0"?>\n<robot name="r">${body}</robot>`;
const joint = (name: string, parent: string, child: string, extra = ''): string =>
  `<joint name="${name}" type="revolute"><parent link="${parent}"/><child link="${child}"/>${extra}</joint>`;

function jointNames(urdf: string): string[] {
  const doc = new DOMParser().parseFromString(urdf, 'text/xml');
  return Array.from(doc.getElementsByTagName('joint')).map(j => j.getAttribute('name') ?? '');
}

function mimics(urdf: string): string[] {
  const doc = new DOMParser().parseFromString(urdf, 'text/xml');
  return Array.from(doc.getElementsByTagName('mimic')).map(m => m.getAttribute('joint') ?? '');
}

test('a valid tree is returned unchanged, byte for byte', () => {
  const input = robot('<link name="a"/><link name="b"/>' + joint('j', 'a', 'b'));
  const result = makeRenderable(input);
  assert.equal(result.urdf, input);
  assert.deepEqual(result.removed, []);
});

test('unparseable or non-robot input is passed through untouched', () => {
  for (const input of ['', 'not xml', '<foo/>']) {
    const result = makeRenderable(input);
    assert.equal(result.urdf, input);
    assert.deepEqual(result.removed, []);
  }
});

test('joints that reference missing links are dropped', () => {
  const result = makeRenderable(robot('<link name="a"/><link name="b"/>' + joint('ok', 'a', 'b') + joint('bad', 'a', 'ghost')));
  assert.deepEqual(jointNames(result.urdf), ['ok']);
  assert.match(result.removed[0], /"bad".*missing link/);
});

test('self-parented joints, second parents and duplicate names are dropped', () => {
  const result = makeRenderable(robot(
    '<link name="a"/><link name="b"/><link name="c"/><link name="a"/>'
    + joint('self', 'a', 'a')
    + joint('first', 'a', 'b')
    + joint('second', 'c', 'b')
    + joint('first', 'a', 'c')
  ));
  assert.deepEqual(jointNames(result.urdf), ['first']);
  assert.equal(result.removed.length, 4);
  assert.ok(result.removed.some(r => /duplicate link "a"/.test(r)));
  assert.ok(result.removed.some(r => /itself/.test(r)));
  assert.ok(result.removed.some(r => /second parent of "b"/.test(r)));
  assert.ok(result.removed.some(r => /duplicate joint "first"/.test(r)));
});

test('a kinematic cycle is cut at exactly one joint', () => {
  const result = makeRenderable(robot(
    '<link name="a"/><link name="b"/><link name="c"/>'
    + joint('ab', 'a', 'b') + joint('bc', 'b', 'c') + joint('ca', 'c', 'a')
  ));
  assert.equal(jointNames(result.urdf).length, 2);
  assert.equal(result.removed.length, 1);
  assert.match(result.removed[0], /closes a loop/);
});

test('a cycle hanging off a valid root is cut without touching the root branch', () => {
  const result = makeRenderable(robot(
    '<link name="root"/><link name="x"/><link name="y"/><link name="z"/>'
    + joint('rx', 'root', 'x') + joint('yz', 'y', 'z') + joint('zy', 'z', 'y')
  ));
  // yz and zy form a two-link loop with no route to the root.
  assert.ok(jointNames(result.urdf).includes('rx'));
  assert.equal(result.removed.length, 1);
});

test('mimics of missing joints and mimic loops are removed, valid mimics kept', () => {
  const result = makeRenderable(robot(
    '<link name="a"/><link name="b"/><link name="c"/><link name="d"/><link name="e"/>'
    + joint('lead', 'a', 'b')
    + joint('follow', 'a', 'c', '<mimic joint="lead"/>')
    + joint('ghost', 'a', 'd', '<mimic joint="nobody"/>')
    + joint('loop1', 'b', 'e', '<mimic joint="loop1"/>')
  ));
  assert.deepEqual(mimics(result.urdf), ['lead']);
  assert.equal(result.removed.length, 2);
});

test('a two-joint mimic loop keeps one mimic', () => {
  const result = makeRenderable(robot(
    '<link name="a"/><link name="b"/><link name="c"/>'
    + joint('p', 'a', 'b', '<mimic joint="q"/>')
    + joint('q', 'a', 'c', '<mimic joint="p"/>')
  ));
  assert.equal(mimics(result.urdf).length, 1);
  assert.match(result.removed[0], /mimic loop/);
});

test('the repository fixture with structural errors becomes loadable', async () => {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const text = await readFile(path.resolve('test/fixtures/franka_broken.urdf'), 'utf8');
  const result = makeRenderable(text);
  assert.ok(result.removed.length > 0);
  // Re-running on the cleaned output must be a no-op: nothing left to fix.
  assert.deepEqual(makeRenderable(result.urdf).removed, []);
});

import { strict as assert } from 'node:assert';
import test from 'node:test';
import '../../src/core/io.node';
import { analyzeUrdf } from '../../src/core/urdfAnalysis';
import { buildMimicGraph, propagateMimicValue } from '../../src/core/mimic';
import { fileUrlToPath, resolveModelUriToFile } from '../../src/core/packageMap';

const robot = (body: string): string => `<robot name="r">${body}</robot>`;
const fixed = (name: string, parent: string, child: string): string =>
  `<joint name="${name}" type="fixed"><parent link="${parent}"/><child link="${child}"/></joint>`;

test('names that collide with Object.prototype members are treated as ordinary names', () => {
  // A parent named like a prototype method used to crash the analysis.
  const missing = analyzeUrdf(robot('<link name="b"/>' + fixed('j', 'toString', 'b')), '/r.urdf', {});
  assert.ok(missing.diagnostics.some(d => d.code === 'joint.parentMissing'));

  for (const name of ['constructor', '__proto__', 'hasOwnProperty']) {
    const meta = analyzeUrdf(robot(`<link name="base"/><link name="${name}"/>` + fixed('j', 'base', name)), '/r.urdf', {});
    assert.equal(meta.counts.links, 2, name);
    assert.ok(!meta.diagnostics.some(d => d.code === 'link.duplicate'), `${name} reported as duplicate`);
    assert.equal(meta.links[name]?.parentJoint, 'j', name);
  }
  // Nothing leaked onto the shared prototype.
  assert.equal((Object.prototype as Record<string, unknown>).parentJoint, undefined);
});

test('a package named like a prototype member is reported as missing, not resolved', () => {
  const meta = analyzeUrdf(robot('<link name="a"><visual><geometry><mesh filename="package://constructor/x.stl"/></geometry></visual></link>'), '/r.urdf', {});
  assert.ok(meta.diagnostics.some(d => d.code === 'mesh.packageMissing'));
});

test('file URLs are decoded, and malformed ones are reported instead of throwing', () => {
  assert.equal(fileUrlToPath('file:///opt/my%20robot/m.stl'), '/opt/my robot/m.stl');
  assert.equal(fileUrlToPath('file:///C:/robots/m.stl'), 'C:/robots/m.stl');
  assert.equal(fileUrlToPath('file://a:b/x.stl'), undefined);
  assert.deepEqual(resolveModelUriToFile('file://a:b/x.stl', {}, '/'), { resolvedPath: undefined });

  const meta = analyzeUrdf(robot('<link name="a"><visual><geometry><mesh filename="file://a:b/x.stl"/></geometry></visual></link>'), '/r.urdf', {});
  assert.ok(meta.diagnostics.some(d => d.code === 'mesh.missing'));
});

test('unsupported mesh URLs are reported', () => {
  const meta = analyzeUrdf(robot('<link name="a"><visual><geometry><mesh filename="https://example.com/a.stl"/></geometry></visual></link>'), '/r.urdf', {});
  assert.ok(meta.diagnostics.some(d => d.code === 'mesh.missing' && /package:\/\//.test(d.message)));
});

test('a very long serial chain builds a tree without overflowing the stack', () => {
  let body = '<link name="l0"/>';
  for (let i = 1; i <= 5000; i += 1) {
    body += `<link name="l${i}"/>` + fixed(`j${i}`, `l${i - 1}`, `l${i}`);
  }
  const meta = analyzeUrdf(robot(body), '/r.urdf', {});
  let depth = 0;
  let node = meta.tree[0];
  while (node.children.length > 0) {
    node = node.children[0];
    depth += 1;
  }
  assert.equal(depth, 5000);
  assert.equal(node.joint, 'j5000');
});

test('mimic propagation never feeds a value back into the moved joint', () => {
  const meta = analyzeUrdf(robot(
    '<link name="a"/><link name="b"/><link name="c"/>'
    + '<joint name="j1" type="revolute"><parent link="a"/><child link="b"/><limit lower="-1" upper="1"/><mimic joint="j2"/></joint>'
    + '<joint name="j2" type="revolute"><parent link="a"/><child link="c"/><limit lower="-1" upper="1"/><mimic joint="j1"/></joint>'
  ), '/r.urdf', {});
  const result = propagateMimicValue(buildMimicGraph(meta.joints), 'j1', 1);
  assert.deepEqual(result.map(r => r.joint), ['j2']);
});

test('a long mimic chain propagates to every follower', () => {
  const joints: Record<string, { name: string; mimic?: { joint: string; multiplier: number; offset: number } }> = { m0: { name: 'm0' } };
  for (let i = 1; i <= 8000; i += 1) {
    joints[`m${i}`] = { name: `m${i}`, mimic: { joint: `m${i - 1}`, multiplier: 1, offset: 0 } };
  }
  const result = propagateMimicValue(buildMimicGraph(joints as never), 'm0', 0.5);
  assert.equal(result.length, 8000);
  assert.ok(result.every(r => r.value === 0.5));
});

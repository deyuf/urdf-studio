import { strict as assert } from 'node:assert';
import test from 'node:test';
import '../../src/core/io.node';
import { analyzeUrdf } from '../../src/core/urdfAnalysis';

const NO_CYCLE = `<?xml version="1.0"?>
<robot name="r">
  <link name="a"/><link name="b"/><link name="c"/>
  <joint name="j1" type="fixed"><parent link="a"/><child link="b"/></joint>
  <joint name="j2" type="fixed"><parent link="b"/><child link="c"/></joint>
</robot>`;

test('detectCycles reports no diagnostic for an acyclic tree', () => {
  const meta = analyzeUrdf(NO_CYCLE, '/virtual.urdf', {});
  const cycles = meta.diagnostics.filter(d => d.code === 'tree.cycle');
  assert.deepEqual(cycles, []);
});

const SIMPLE_CYCLE = `<?xml version="1.0"?>
<robot name="r">
  <link name="a"/><link name="b"/><link name="c"/>
  <joint name="j1" type="fixed"><parent link="a"/><child link="b"/></joint>
  <joint name="j2" type="fixed"><parent link="b"/><child link="c"/></joint>
  <joint name="j3" type="fixed"><parent link="c"/><child link="a"/></joint>
</robot>`;

test('detectCycles reports a cycle on a 3-node loop', () => {
  const meta = analyzeUrdf(SIMPLE_CYCLE, '/virtual.urdf', {});
  const cycles = meta.diagnostics.filter(d => d.code === 'tree.cycle');
  assert.ok(cycles.length >= 1, `expected at least one cycle diagnostic, got ${JSON.stringify(meta.diagnostics)}`);
  // The cycle path printed must include all three nodes.
  for (const node of ['a', 'b', 'c']) {
    assert.ok(cycles[0].message.includes(node), `cycle message should mention ${node}: ${cycles[0].message}`);
  }
});

test('detectCycles dedupes the same cycle reached from different roots', () => {
  // The cycle a→b→c→a is reachable from any node in the cycle. We assert that
  // the diagnostic is emitted at most a small constant number of times (with
  // the new dedup logic: exactly 1).
  const meta = analyzeUrdf(SIMPLE_CYCLE, '/virtual.urdf', {});
  const cycles = meta.diagnostics.filter(d => d.code === 'tree.cycle');
  assert.equal(cycles.length, 1, `expected exactly one cycle diagnostic, got ${cycles.length}`);
});

test('detectCycles handles a self-loop link', () => {
  const urdf = `<?xml version="1.0"?>
<robot name="r">
  <link name="solo"/>
  <joint name="j" type="fixed"><parent link="solo"/><child link="solo"/></joint>
</robot>`;
  const meta = analyzeUrdf(urdf, '/v.urdf', {});
  const cycles = meta.diagnostics.filter(d => d.code === 'tree.cycle');
  assert.ok(cycles.length >= 1);
  assert.match(cycles[0].message, /solo/);
});

test('detectCycles still functions on a deep linear chain (no false positive, no stack overflow)', () => {
  // 200-link linear chain — the old recursive implementation allocated
  // `[...path, link]` clones per frame; this test guards against regression
  // in case someone reintroduces O(V*E) cloning.
  const N = 200;
  const links = Array.from({ length: N }, (_, i) => `<link name="l${i}"/>`).join('\n');
  const joints = Array.from({ length: N - 1 }, (_, i) =>
    `<joint name="j${i}" type="fixed"><parent link="l${i}"/><child link="l${i + 1}"/></joint>`
  ).join('\n');
  const urdf = `<?xml version="1.0"?><robot name="chain">${links}${joints}</robot>`;
  const meta = analyzeUrdf(urdf, '/v.urdf', {});
  const cycles = meta.diagnostics.filter(d => d.code === 'tree.cycle');
  assert.deepEqual(cycles, []);
  assert.equal(meta.counts.links, N);
});

test('detectCycles spots two disjoint cycles separately', () => {
  const urdf = `<?xml version="1.0"?>
<robot name="r">
  <link name="a"/><link name="b"/>
  <link name="c"/><link name="d"/>
  <joint name="ab" type="fixed"><parent link="a"/><child link="b"/></joint>
  <joint name="ba" type="fixed"><parent link="b"/><child link="a"/></joint>
  <joint name="cd" type="fixed"><parent link="c"/><child link="d"/></joint>
  <joint name="dc" type="fixed"><parent link="d"/><child link="c"/></joint>
</robot>`;
  // Each link will be reported as multiParents AND cycles. We assert cycles
  // is at least 2 (one per loop) and at most 4 (one report per loop start).
  const meta = analyzeUrdf(urdf, '/v.urdf', {});
  const cycles = meta.diagnostics.filter(d => d.code === 'tree.cycle');
  assert.ok(cycles.length >= 2 && cycles.length <= 4, `expected 2-4 cycle reports, got ${cycles.length}`);
});

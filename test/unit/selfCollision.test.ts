import { strict as assert } from 'node:assert';
import test from 'node:test';
import {
  canonicalPair,
  buildDisabledPairSet,
  isAdjacent,
  planCollisionPairs
} from '../../src/renderer/logic/selfCollision';
import type { JointInfo, LinkInfo } from '../../src/core/types';

// =============================================================================
// canonicalPair
// =============================================================================

test('canonicalPair returns the same key regardless of argument order', () => {
  assert.equal(canonicalPair('a', 'b'), 'a|b');
  assert.equal(canonicalPair('b', 'a'), 'a|b');
});

test('canonicalPair handles identical inputs', () => {
  assert.equal(canonicalPair('x', 'x'), 'x|x');
});

// =============================================================================
// buildDisabledPairSet
// =============================================================================

test('buildDisabledPairSet maps SRDF entries to canonical keys', () => {
  const set = buildDisabledPairSet([
    { link1: 'a', link2: 'b' },
    { link1: 'c', link2: 'd' }
  ]);
  assert.equal(set.size, 2);
  assert.ok(set.has('a|b'));
  assert.ok(set.has('c|d'));
});

test('buildDisabledPairSet dedupes reversed pairs', () => {
  const set = buildDisabledPairSet([
    { link1: 'a', link2: 'b' },
    { link1: 'b', link2: 'a' }
  ]);
  assert.equal(set.size, 1);
  assert.ok(set.has('a|b'));
});

test('buildDisabledPairSet returns empty set for null / undefined', () => {
  assert.equal(buildDisabledPairSet(null).size, 0);
  assert.equal(buildDisabledPairSet(undefined).size, 0);
});

test('buildDisabledPairSet skips entries missing link1 or link2', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const malformed: any[] = [
    { link1: 'a', link2: 'b' },
    { link1: '', link2: 'b' },
    { link1: 'a' },
    { link2: 'b' },
    null
  ];
  const set = buildDisabledPairSet(malformed);
  assert.equal(set.size, 1);
  assert.ok(set.has('a|b'));
});

// =============================================================================
// isAdjacent
// =============================================================================

function makeChain(): { links: Record<string, LinkInfo>; joints: Record<string, JointInfo> } {
  // a -- joint_ab --> b -- joint_bc --> c
  return {
    links: {
      a: { name: 'a', childJoints: ['joint_ab'] },
      b: { name: 'b', parentJoint: 'joint_ab', childJoints: ['joint_bc'] },
      c: { name: 'c', parentJoint: 'joint_bc', childJoints: [] }
    },
    joints: {
      joint_ab: { name: 'joint_ab', type: 'fixed', parent: 'a', child: 'b', axis: [0, 0, 1], limit: {} },
      joint_bc: { name: 'joint_bc', type: 'fixed', parent: 'b', child: 'c', axis: [0, 0, 1], limit: {} }
    }
  };
}

test('isAdjacent: parent → child pair is adjacent', () => {
  const { links, joints } = makeChain();
  assert.equal(isAdjacent('a', 'b', links, joints), true);
});

test('isAdjacent: child → parent pair is adjacent (order independent)', () => {
  const { links, joints } = makeChain();
  assert.equal(isAdjacent('b', 'a', links, joints), true);
});

test('isAdjacent: grandparent → grandchild is NOT adjacent', () => {
  const { links, joints } = makeChain();
  assert.equal(isAdjacent('a', 'c', links, joints), false);
});

test('isAdjacent: unknown links return false instead of throwing', () => {
  const { links, joints } = makeChain();
  assert.equal(isAdjacent('a', 'missing', links, joints), false);
  assert.equal(isAdjacent('missing', 'a', links, joints), false);
});

test('isAdjacent: same link as both sides is not adjacent', () => {
  const { links, joints } = makeChain();
  assert.equal(isAdjacent('a', 'a', links, joints), false);
});

// =============================================================================
// planCollisionPairs
// =============================================================================

test('planCollisionPairs excludes reflexive, adjacent, and disabled pairs', () => {
  const { links, joints } = makeChain();
  // Two mesh entries per link a/b/c so multiple geometries map to the same
  // link (mimics what URDFs with multiple <collision> tags produce).
  const meshes = [
    { ownerLink: 'a' }, { ownerLink: 'a' },
    { ownerLink: 'b' },
    { ownerLink: 'c' }, { ownerLink: 'c' }
  ];
  const planned = planCollisionPairs({
    meshes,
    links,
    joints,
    disabledPairs: new Set()
  });
  // a↔b adjacent → excluded
  // b↔c adjacent → excluded
  // a↔c → KEPT (grandparent / grandchild can self-collide)
  // a↔a / c↔c → reflexive, excluded
  assert.deepEqual(planned.sort(), ['a|c']);
});

test('planCollisionPairs respects an SRDF disabled set', () => {
  const { links, joints } = makeChain();
  // Force a↔c into the disabled set.
  const planned = planCollisionPairs({
    meshes: [{ ownerLink: 'a' }, { ownerLink: 'b' }, { ownerLink: 'c' }],
    links,
    joints,
    disabledPairs: new Set(['a|c'])
  });
  assert.deepEqual(planned, []);
});

test('planCollisionPairs returns unique canonical keys only', () => {
  // 4 distinct links → 6 pairs. With no adjacency / disables we expect 6 keys.
  const links: Record<string, LinkInfo> = {
    p: { name: 'p', childJoints: [] },
    q: { name: 'q', childJoints: [] },
    r: { name: 'r', childJoints: [] },
    s: { name: 'q', childJoints: [] }
  };
  const planned = planCollisionPairs({
    meshes: [{ ownerLink: 'p' }, { ownerLink: 'q' }, { ownerLink: 'r' }, { ownerLink: 's' }],
    links,
    joints: {},
    disabledPairs: new Set()
  });
  assert.equal(planned.length, 6);
  assert.equal(new Set(planned).size, 6, 'keys must be unique');
});

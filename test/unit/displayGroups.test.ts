import { strict as assert } from 'node:assert';
import test from 'node:test';
import { buildDisplayGroups, jointRange } from '../../src/renderer/logic/displayGroups';
import type { JointInfo, RobotMetadata, SemanticMetadata } from '../../src/core/types';

function meta(movable: string[]): Pick<RobotMetadata, 'movableJointNames'> {
  return { movableJointNames: movable };
}

function semantic(groups: SemanticMetadata['groups']): Pick<SemanticMetadata, 'groups'> {
  return { groups };
}

// =============================================================================
// buildDisplayGroups
// =============================================================================

test('buildDisplayGroups uses SRDF groups when they cover any movable joints', () => {
  const result = buildDisplayGroups(
    meta(['shoulder', 'elbow', 'wrist']),
    semantic([{ name: 'arm', joints: ['shoulder', 'elbow', 'wrist'] }])
  );
  assert.deepEqual(result, [{ name: 'arm', joints: ['shoulder', 'elbow', 'wrist'] }]);
});

test('buildDisplayGroups intersects SRDF group joints with the movable set', () => {
  // SRDF lists joints that include fixed ones; only movable joints should
  // appear in the panel.
  const result = buildDisplayGroups(
    meta(['shoulder', 'elbow']),                // 'fixed_joint' NOT movable
    semantic([{ name: 'arm', joints: ['shoulder', 'elbow', 'fixed_joint'] }])
  );
  assert.deepEqual(result, [{ name: 'arm', joints: ['shoulder', 'elbow'] }]);
});

test('buildDisplayGroups drops SRDF groups whose joints are all non-movable', () => {
  const result = buildDisplayGroups(
    meta(['shoulder', 'elbow']),
    semantic([
      { name: 'arm', joints: ['shoulder', 'elbow'] },
      { name: 'gripper', joints: ['knuckle'] } // 'knuckle' is not movable
    ])
  );
  assert.deepEqual(result, [{ name: 'arm', joints: ['shoulder', 'elbow'] }]);
});

test('buildDisplayGroups falls back to prefix bucketing when no SRDF group hits', () => {
  const result = buildDisplayGroups(
    meta(['arm_left_shoulder', 'arm_left_elbow', 'arm_right_shoulder', 'gripper_finger']),
    semantic([])
  );
  const byName = Object.fromEntries(result.map(g => [g.name, g.joints]));
  assert.deepEqual(byName.arm, ['arm_left_shoulder', 'arm_left_elbow', 'arm_right_shoulder']);
  assert.deepEqual(byName.gripper, ['gripper_finger']);
});

test('buildDisplayGroups falls back to "all" bucket for joints without underscores', () => {
  const result = buildDisplayGroups(meta(['hinge', 'lift', 'twist']), semantic([]));
  assert.deepEqual(result, [{ name: 'all', joints: ['hinge', 'lift', 'twist'] }]);
});

test('buildDisplayGroups returns an empty list when there are no movable joints', () => {
  assert.deepEqual(buildDisplayGroups(meta([]), semantic([])), []);
});

test('buildDisplayGroups does NOT mutate its inputs', () => {
  const moveList = ['arm_a', 'arm_b'];
  const grpInput = [{ name: 'arm', joints: ['arm_a', 'arm_b'] }];
  const moveCopy = [...moveList];
  const grpCopy = grpInput.map(g => ({ name: g.name, joints: [...g.joints] }));
  buildDisplayGroups(meta(moveList), semantic(grpInput));
  assert.deepEqual(moveList, moveCopy);
  assert.deepEqual(grpInput, grpCopy);
});

// =============================================================================
// jointRange
// =============================================================================

function rev(name: string, lower?: number, upper?: number): JointInfo {
  return {
    name,
    type: 'revolute',
    parent: 'p',
    child: 'c',
    axis: [0, 0, 1],
    limit: { lower, upper }
  };
}

test('jointRange returns explicit limits when both are set', () => {
  assert.deepEqual(jointRange(rev('j', -0.7, 1.4)), [-0.7, 1.4]);
});

test('jointRange defaults a revolute joint without limits to ±π', () => {
  assert.deepEqual(jointRange(rev('j', undefined, undefined)), [-Math.PI, Math.PI]);
});

test('jointRange treats continuous joints as ±π regardless of declared limits', () => {
  const joint: JointInfo = { ...rev('j', -10, 10), type: 'continuous' };
  assert.deepEqual(jointRange(joint), [-Math.PI, Math.PI]);
});

test('jointRange defaults a prismatic joint without limits to ±1m', () => {
  const joint: JointInfo = { ...rev('j', undefined, undefined), type: 'prismatic' };
  assert.deepEqual(jointRange(joint), [-1, 1]);
});

test('jointRange uses prismatic explicit limits when present', () => {
  const joint: JointInfo = { ...rev('j', 0, 0.08), type: 'prismatic' };
  assert.deepEqual(jointRange(joint), [0, 0.08]);
});

test('jointRange handles "only lower defined" by falling back to ±π', () => {
  // Both bounds need to be set, otherwise the fallback kicks in. This
  // matches the legacy renderer behaviour: a partial limit is treated as no
  // limit so the slider doesn't silently clamp one direction.
  const joint = rev('j', -1, undefined);
  assert.deepEqual(jointRange(joint), [-Math.PI, Math.PI]);
});

test('jointRange returns ±π for undefined joint', () => {
  assert.deepEqual(jointRange(undefined), [-Math.PI, Math.PI]);
});

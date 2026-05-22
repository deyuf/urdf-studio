import { strict as assert } from 'node:assert';
import test from 'node:test';
import * as THREE from 'three';
import { InertiaVisualisation, type InertiaDeps } from '../../src/renderer/features/inertia';
import type { RobotMetadata } from '../../src/core/types';

// Minimal URDFRobot-like fixture: a THREE.Group with a `links` map.
class FakeRobot extends THREE.Group {
  links: Record<string, THREE.Object3D> = {};
}

function makeRobot(linkNames: string[]): FakeRobot {
  const robot = new FakeRobot();
  for (const name of linkNames) {
    const o = new THREE.Object3D();
    robot.add(o);
    robot.links[name] = o;
  }
  return robot;
}

function makeMetadata(linkMassPairs: Array<{ name: string; mass: number; origin?: [number, number, number] }>): RobotMetadata {
  const links: Record<string, RobotMetadata['links'][string]> = {};
  let totalMass = 0;
  for (const { name, mass, origin } of linkMassPairs) {
    links[name] = {
      name,
      childJoints: [],
      inertial: mass > 0 ? {
        mass,
        origin: origin ?? [0, 0, 0],
        rotation: [0, 0, 0],
        ixx: 0.01, ixy: 0, ixz: 0,
        iyy: 0.02, iyz: 0,
        izz: 0.03
      } : undefined
    };
    totalMass += Math.max(0, mass);
  }
  return {
    robotName: 'r',
    counts: { links: linkMassPairs.length, joints: 0, movableJoints: 0, visualMeshes: 0, collisionMeshes: 0 },
    links,
    joints: {},
    meshes: [],
    rootLinks: linkMassPairs.map(p => p.name).slice(0, 1),
    movableJointNames: [],
    tree: [],
    totalMass,
    diagnostics: []
  };
}

function makeInertia(overrides: Partial<InertiaDeps> = {}) {
  const scene = new THREE.Scene();
  let redraws = 0;
  let stateChanges = 0;
  const inertia = new InertiaVisualisation({
    scene,
    getBoundsRadius: () => 1,
    requestRedraw: () => { redraws++; },
    onStateChange: () => { stateChanges++; },
    ...overrides
  });
  return {
    inertia, scene,
    get redraws() { return redraws; },
    get stateChanges() { return stateChanges; }
  };
}

// =============================================================================
// build / helperCount / dispose
// =============================================================================

test('InertiaVisualisation starts empty', () => {
  const { inertia } = makeInertia();
  assert.equal(inertia.helperCount(), 0);
  assert.equal(inertia.hasTotalMarker(), false);
  assert.equal(inertia.isVisible(), false);
});

test('build() creates one helper per link with positive mass', () => {
  const { inertia } = makeInertia();
  const robot = makeRobot(['a', 'b', 'c']);
  const meta = makeMetadata([
    { name: 'a', mass: 1 },
    { name: 'b', mass: 2 },
    { name: 'c', mass: 0 }   // skipped
  ]);
  inertia.build(robot as never, meta);
  assert.equal(inertia.helperCount(), 2, 'links with mass <= 0 must be skipped');
});

test('build() creates the aggregate-CoM marker only when totalMass > 0', () => {
  const { inertia } = makeInertia();
  const robot = makeRobot(['a']);
  inertia.build(robot as never, makeMetadata([{ name: 'a', mass: 1 }]));
  assert.equal(inertia.hasTotalMarker(), true);
});

test('build() with zero total mass does NOT add the aggregate marker', () => {
  const { inertia } = makeInertia();
  const robot = makeRobot(['a']);
  inertia.build(robot as never, makeMetadata([{ name: 'a', mass: 0 }]));
  assert.equal(inertia.hasTotalMarker(), false);
});

test('dispose() wipes helpers and the aggregate marker', () => {
  const { inertia, scene } = makeInertia();
  const robot = makeRobot(['a', 'b']);
  inertia.build(robot as never, makeMetadata([{ name: 'a', mass: 1 }, { name: 'b', mass: 2 }]));
  inertia.dispose();
  assert.equal(inertia.helperCount(), 0);
  assert.equal(inertia.hasTotalMarker(), false);
  // Scene should no longer carry the total marker mesh.
  let totalMarkerInScene = false;
  scene.traverse(obj => { if (obj.parent === scene && (obj as THREE.Mesh).isMesh) totalMarkerInScene = true; });
  assert.equal(totalMarkerInScene, false, 'aggregate marker must be detached from scene');
});

// =============================================================================
// Visibility
// =============================================================================

test('setVisible(true) flips visibility on all helpers and the aggregate marker', () => {
  const { inertia } = makeInertia();
  const robot = makeRobot(['a', 'b']);
  const meta = makeMetadata([{ name: 'a', mass: 1 }, { name: 'b', mass: 2 }]);
  inertia.build(robot as never, meta);
  inertia.setVisible(true, robot as never, meta);
  assert.equal(inertia.isVisible(), true);
  // Spot-check: at least one helper group is visible.
  for (const link of Object.values(robot.links)) {
    const helper = link.children[0];
    if (helper) {
      assert.equal(helper.visible, true);
    }
  }
});

test('setVisible(true) then setVisible(false) toggles helpers off', () => {
  const { inertia } = makeInertia();
  const robot = makeRobot(['a']);
  const meta = makeMetadata([{ name: 'a', mass: 1 }]);
  inertia.build(robot as never, meta);
  inertia.setVisible(true, robot as never, meta);
  inertia.setVisible(false, robot as never, meta);
  assert.equal(inertia.isVisible(), false);
  for (const link of Object.values(robot.links)) {
    const helper = link.children[0];
    if (helper) {
      assert.equal(helper.visible, false);
    }
  }
});

test('refreshTotal() is a no-op when invisible', () => {
  const ctx = makeInertia();
  const robot = makeRobot(['a']);
  const meta = makeMetadata([{ name: 'a', mass: 1, origin: [0.1, 0.2, 0.3] }]);
  ctx.inertia.build(robot as never, meta);
  const baselineRedraws = ctx.redraws;
  ctx.inertia.refreshTotal(robot as never, meta);
  // No requestRedraw should have fired — we didn't make anything visible
  // change.
  assert.equal(ctx.redraws, baselineRedraws);
});

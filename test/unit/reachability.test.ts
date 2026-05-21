import { strict as assert } from 'node:assert';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import { Reachability, type ReachabilityDeps } from '../../src/renderer/features/reachability';
import type { RobotMetadata } from '../../src/core/types';

const dom = new JSDOM('<!doctype html><html><body><div id="reach-status"></div></body></html>');
(globalThis as { document: Document }).document = dom.window.document;
(globalThis as { window: Window }).window = dom.window as unknown as Window;

// Minimal URDFRobot-like fixture. The class extends THREE.Group so
// Box3.setFromObject() can traverse it. We bolt on a `joints` map and a
// `links` map onto the Group instance the way urdf-loader does.
class FakeRobot extends THREE.Group {
  joints: Record<string, { angle: number; ignoreLimits: boolean }> = {
    joint1: { angle: 0, ignoreLimits: false },
    joint2: { angle: 0, ignoreLimits: false }
  };
  links: Record<string, THREE.Object3D> = {};
  lastJointValues: Record<string, number> = {};

  setJointValue(name: string, value: number): boolean {
    this.lastJointValues[name] = value;
    const j = this.joints[name];
    if (j) {
      j.angle = value;
    }
    return true;
  }
}

function fakeRobot(opts: { tipName?: string; tipWorld?: [number, number, number] } = {}): FakeRobot {
  const tipName = opts.tipName ?? 'tip';
  const robot = new FakeRobot();
  // Add a small mesh so the robot's bounding box is non-empty; otherwise
  // Box3.setFromObject() returns an empty box and the fit-camera code path
  // is skipped.
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1));
  robot.add(body);
  const tip = new THREE.Object3D();
  if (opts.tipWorld) {
    tip.position.set(...opts.tipWorld);
  }
  robot.add(tip);
  robot.links[tipName] = tip;
  return robot;
}

function fakeMetadata(): RobotMetadata {
  return {
    robotName: 'rob',
    counts: { links: 2, joints: 2, movableJoints: 2, visualMeshes: 0, collisionMeshes: 0 },
    links: {
      base: { name: 'base', childJoints: ['joint1'] },
      tip: { name: 'tip', parentJoint: 'joint2', childJoints: [] }
    },
    joints: {
      joint1: { name: 'joint1', type: 'revolute', parent: 'base', child: 'middle', axis: [0, 0, 1], limit: { lower: -1, upper: 1 } },
      joint2: { name: 'joint2', type: 'revolute', parent: 'middle', child: 'tip', axis: [0, 1, 0], limit: { lower: -0.5, upper: 0.5 } }
    },
    meshes: [],
    rootLinks: ['base'],
    movableJointNames: ['joint1', 'joint2'],
    tree: [],
    totalMass: 0,
    diagnostics: []
  };
}

function makeReachability(overrides: Partial<ReachabilityDeps> = {}) {
  const scene = new THREE.Scene();
  let redraws = 0;
  let stateChanges = 0;
  let lastFitBox: THREE.Box3 | undefined;
  const r = new Reachability({
    scene,
    fitCameraToBox: box => { lastFitBox = box; },
    requestRedraw: () => { redraws++; },
    onStateChange: () => { stateChanges++; },
    ...overrides
  });
  return {
    r, scene,
    get redraws() { return redraws; },
    get stateChanges() { return stateChanges; },
    get lastFitBox() { return lastFitBox; }
  };
}

// =============================================================================
// Idle state / dispose
// =============================================================================

test('Reachability starts with no rendered points', () => {
  const { r } = makeReachability();
  assert.equal(r.isVisible(), false);
  assert.equal(r.pointCount(), 0);
});

test('dispose() on an empty cloud is a no-op (no throw, no redraw)', () => {
  const { r, redraws } = makeReachability();
  r.dispose();
  assert.equal(redraws, 0, 'must not request a redraw when there is nothing to dispose');
});

test('sample() rejects an unknown tip link with a status message', async () => {
  const { r } = makeReachability();
  const fake = fakeRobot({ tipName: 'tip' });
  const result = await r.sample({
    robot: fake as never,
    metadata: fakeMetadata(),
    tipLinkName: 'no_such_tip',
    sampleCount: 10,
    poseBeforeSampling: {},
    applyPose: () => {},
    propagateMimics: () => {}
  });
  assert.equal(result, undefined);
  const status = document.getElementById('reach-status');
  assert.match(status?.textContent ?? '', /Pick a valid tip link/);
  assert.equal(r.pointCount(), 0);
});

test('sample() rejects when there are no movable joints', async () => {
  const { r } = makeReachability();
  const fake = fakeRobot({ tipName: 'tip' });
  const meta = fakeMetadata();
  meta.movableJointNames = [];
  const result = await r.sample({
    robot: fake as never,
    metadata: meta,
    tipLinkName: 'tip',
    sampleCount: 10,
    poseBeforeSampling: {},
    applyPose: () => {},
    propagateMimics: () => {}
  });
  assert.equal(result, undefined);
  const status = document.getElementById('reach-status');
  assert.match(status?.textContent ?? '', /No movable joints/);
});

// =============================================================================
// Successful sampling
// =============================================================================

test('sample() produces the requested number of points in the scene', async () => {
  const { r, scene } = makeReachability();
  const fake = fakeRobot({ tipName: 'tip', tipWorld: [0.1, 0.2, 0.3] });
  const result = await r.sample({
    robot: fake as never,
    metadata: fakeMetadata(),
    tipLinkName: 'tip',
    sampleCount: 50,
    poseBeforeSampling: { joint1: 0, joint2: 0 },
    applyPose: () => {},
    propagateMimics: () => {}
  });
  assert.ok(result, 'sample should resolve with a non-null result');
  assert.equal(result!.sampleCount, 50);
  assert.equal(r.pointCount(), 50);
  // The scene should contain exactly one Points object.
  const points: THREE.Points[] = [];
  scene.traverse(obj => {
    if ((obj as THREE.Points).isPoints) points.push(obj as THREE.Points);
  });
  assert.equal(points.length, 1);
});

test('sample() restores the pose-before-sampling on completion', async () => {
  const restored: Record<string, number>[] = [];
  const { r } = makeReachability();
  const fake = fakeRobot();
  const beforePose = { joint1: 0.3, joint2: -0.2 };
  await r.sample({
    robot: fake as never,
    metadata: fakeMetadata(),
    tipLinkName: 'tip',
    sampleCount: 10,
    poseBeforeSampling: beforePose,
    applyPose: pose => { restored.push({ ...pose }); },
    propagateMimics: () => {}
  });
  assert.deepEqual(restored.at(-1), beforePose);
});

test('sample() bypasses URDFLoader joint limits during the loop and restores them after', async () => {
  // joint1 starts with ignoreLimits=false. The sampler must flip it to true
  // during the loop and restore the original `false` once done.
  const fake = fakeRobot();
  fake.joints.joint1.ignoreLimits = false;
  let observedDuringLoop = false;
  const originalSet = fake.setJointValue.bind(fake);
  fake.setJointValue = function (name: string, value: number) {
    if (name === 'joint1' && this.joints.joint1.ignoreLimits === true) {
      observedDuringLoop = true;
    }
    return originalSet(name, value);
  };
  const { r } = makeReachability();
  await r.sample({
    robot: fake as never,
    metadata: fakeMetadata(),
    tipLinkName: 'tip',
    sampleCount: 5,
    poseBeforeSampling: {},
    applyPose: () => {},
    propagateMimics: () => {}
  });
  assert.equal(observedDuringLoop, true, 'ignoreLimits should have been toggled true during the loop');
  assert.equal(fake.joints.joint1.ignoreLimits, false, 'ignoreLimits should be restored after the loop');
});

test('sample() requests a camera refit + redraw on success', async () => {
  const ctx = makeReachability();
  const fake = fakeRobot({ tipName: 'tip' });
  await ctx.r.sample({
    robot: fake as never,
    metadata: fakeMetadata(),
    tipLinkName: 'tip',
    sampleCount: 10,
    poseBeforeSampling: {},
    applyPose: () => {},
    propagateMimics: () => {}
  });
  assert.ok(ctx.lastFitBox, 'fitCameraToBox must be invoked with a non-null box');
  assert.ok(ctx.redraws > 0, 'must request a redraw on success');
});

test('sample() invokes propagateMimics once per iteration', async () => {
  let mimicCalls = 0;
  const { r } = makeReachability();
  const fake = fakeRobot();
  await r.sample({
    robot: fake as never,
    metadata: fakeMetadata(),
    tipLinkName: 'tip',
    sampleCount: 7,
    poseBeforeSampling: {},
    applyPose: () => {},
    propagateMimics: () => { mimicCalls++; }
  });
  assert.equal(mimicCalls, 7, `expected 7 propagateMimics calls, got ${mimicCalls}`);
});

// =============================================================================
// Repeated dispose / re-sample
// =============================================================================

test('Calling sample() twice replaces the prior cloud', async () => {
  const { r, scene } = makeReachability();
  const fake = fakeRobot();
  await r.sample({
    robot: fake as never,
    metadata: fakeMetadata(),
    tipLinkName: 'tip',
    sampleCount: 20,
    poseBeforeSampling: {},
    applyPose: () => {},
    propagateMimics: () => {}
  });
  await r.sample({
    robot: fake as never,
    metadata: fakeMetadata(),
    tipLinkName: 'tip',
    sampleCount: 35,
    poseBeforeSampling: {},
    applyPose: () => {},
    propagateMimics: () => {}
  });
  assert.equal(r.pointCount(), 35);
  let pointsObjs = 0;
  scene.traverse(obj => { if ((obj as THREE.Points).isPoints) pointsObjs++; });
  assert.equal(pointsObjs, 1, 'only the latest cloud should remain in the scene');
});

test('dispose() after a successful sample removes the cloud from the scene', async () => {
  const { r, scene } = makeReachability();
  const fake = fakeRobot();
  await r.sample({
    robot: fake as never,
    metadata: fakeMetadata(),
    tipLinkName: 'tip',
    sampleCount: 20,
    poseBeforeSampling: {},
    applyPose: () => {},
    propagateMimics: () => {}
  });
  r.dispose();
  assert.equal(r.pointCount(), 0);
  let pointsObjs = 0;
  scene.traverse(obj => { if ((obj as THREE.Points).isPoints) pointsObjs++; });
  assert.equal(pointsObjs, 0);
});

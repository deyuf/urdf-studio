import { strict as assert } from 'node:assert';
import test from 'node:test';
import * as THREE from 'three';
import { FramesOverlay, type FramesDeps } from '../../src/renderer/features/frames';

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

function makeOverlay(overrides: Partial<FramesDeps> = {}) {
  let redraws = 0;
  let stateChanges = 0;
  const overlay = new FramesOverlay({
    getBoundsRadius: () => 1,
    requestRedraw: () => { redraws++; },
    onStateChange: () => { stateChanges++; },
    ...overrides
  });
  return {
    overlay,
    get redraws() { return redraws; },
    get stateChanges() { return stateChanges; }
  };
}

// =============================================================================
// Mode machine
// =============================================================================

test('FramesOverlay starts in "off" with no visible helpers', () => {
  const { overlay } = makeOverlay();
  assert.equal(overlay.current(), 'off');
  assert.equal(overlay.visibleCount(), 0);
});

test('apply("all", robot, undefined) creates and shows one helper per link', () => {
  const { overlay } = makeOverlay();
  const robot = makeRobot(['a', 'b', 'c']);
  overlay.apply('all', robot as never, undefined);
  assert.equal(overlay.current(), 'all');
  assert.equal(overlay.visibleCount(), 3);
});

test('apply("selected", robot, "b") shows exactly one helper on link "b"', () => {
  const { overlay } = makeOverlay();
  const robot = makeRobot(['a', 'b', 'c']);
  overlay.apply('selected', robot as never, 'b');
  assert.equal(overlay.visibleCount(), 1);
  // Helper is parented under link "b".
  const b = robot.links.b;
  const helper = b.children[0];
  assert.ok(helper);
  assert.equal(helper.visible, true);
});

test('apply("off", robot, undefined) hides all helpers without destroying them', () => {
  const { overlay } = makeOverlay();
  const robot = makeRobot(['a', 'b']);
  overlay.apply('all', robot as never, undefined);
  overlay.apply('off', robot as never, undefined);
  assert.equal(overlay.visibleCount(), 0);
});

test('apply() switches the selected link without leaking the previous helper', () => {
  const { overlay } = makeOverlay();
  const robot = makeRobot(['a', 'b']);
  overlay.apply('selected', robot as never, 'a');
  overlay.apply('selected', robot as never, 'b');
  // Only b's helper is visible.
  assert.equal(overlay.visibleCount(), 1);
  assert.equal(robot.links.b.children[0].visible, true);
  // a's helper exists but is hidden.
  const aHelper = robot.links.a.children[0];
  assert.ok(aHelper);
  assert.equal(aHelper.visible, false);
});

// =============================================================================
// Reuse + scaling
// =============================================================================

test('apply() reuses the existing helper instead of creating a new one', () => {
  const { overlay } = makeOverlay();
  const robot = makeRobot(['a']);
  overlay.apply('all', robot as never, undefined);
  const helperFirst = robot.links.a.children[0];
  overlay.apply('all', robot as never, undefined);
  const helperSecond = robot.links.a.children[0];
  assert.equal(helperFirst, helperSecond, 'helper should be reused across apply() calls');
});

test('apply() scales helpers when getBoundsRadius changes', () => {
  let radius = 1;
  const { overlay } = makeOverlay({ getBoundsRadius: () => radius });
  const robot = makeRobot(['a']);
  overlay.apply('all', robot as never, undefined);
  const helper = robot.links.a.children[0];
  const scaleSmall = helper.scale.x;
  radius = 10;
  overlay.apply('all', robot as never, undefined);
  assert.ok(helper.scale.x > scaleSmall, `expected scale to grow with bounds, got ${helper.scale.x}`);
});

// =============================================================================
// Dispose
// =============================================================================

test('dispose() removes all helpers from their parent links', () => {
  const { overlay } = makeOverlay();
  const robot = makeRobot(['a', 'b']);
  overlay.apply('all', robot as never, undefined);
  assert.equal(robot.links.a.children.length, 1);
  overlay.dispose();
  assert.equal(robot.links.a.children.length, 0);
  assert.equal(robot.links.b.children.length, 0);
  assert.equal(overlay.visibleCount(), 0);
});

// =============================================================================
// Robot guard
// =============================================================================

test('apply() with undefined robot does not throw', () => {
  const { overlay } = makeOverlay();
  overlay.apply('all', undefined, undefined);
  // No assertion beyond not throwing.
});

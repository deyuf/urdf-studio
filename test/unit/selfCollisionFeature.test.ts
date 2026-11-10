// Behavioural tests for the SelfCollision feature module.
//
// The BVH narrow-phase requires a real WebGL-capable THREE pipeline that
// Node can't run, so the focus here is on the *control-flow* surface:
//   - enabled / disabled state machine
//   - leading + trailing debounce schedule
//   - dispose semantics
// The geometric integration is still covered end-to-end by the renderer
// Playwright suite.

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { SelfCollision, type SelfCollisionDeps } from '../../src/renderer/features/selfCollision';

const dom = new JSDOM('<!doctype html><html><body><div id="collide-hud"></div></body></html>');
(globalThis as { document: Document }).document = dom.window.document;
(globalThis as { window: Window }).window = dom.window as unknown as Window;

// requestAnimationFrame shim that we drive manually so debounce tests are
// deterministic (no race against a real animation tick).
let rafQueue: FrameRequestCallback[] = [];
(globalThis as { requestAnimationFrame?: (cb: FrameRequestCallback) => number }).requestAnimationFrame =
  (cb: FrameRequestCallback) => {
    rafQueue.push(cb);
    return rafQueue.length;
  };

function flushRaf(): number {
  // Drain everything currently in the queue, including any new entries that
  // get added while the existing callbacks fire.
  let fired = 0;
  while (rafQueue.length > 0) {
    const callbacks = rafQueue;
    rafQueue = [];
    for (const cb of callbacks) {
      cb(performance.now());
      fired++;
    }
  }
  return fired;
}

/** Fire exactly one batch of pending RAFs without draining anything that
 *  gets enqueued during their execution. */
function fireOneFrame(): number {
  const callbacks = rafQueue;
  rafQueue = [];
  for (const cb of callbacks) {
    cb(performance.now());
  }
  return callbacks.length;
}

function makeSc(overrides: Partial<SelfCollisionDeps> = {}) {
  let redraws = 0;
  let stateChanges = 0;
  const sc = new SelfCollision({
    requestRedraw: () => { redraws++; },
    onStateChange: () => { stateChanges++; },
    ...overrides
  });
  return {
    sc,
    get redraws() { return redraws; },
    get stateChanges() { return stateChanges; }
  };
}

// =============================================================================
// Idle / enabled
// =============================================================================

test('SelfCollision starts disabled', () => {
  const { sc } = makeSc();
  assert.equal(sc.isEnabled(), false);
  assert.equal(sc.hasGeometryIndex(), false);
  assert.equal(sc.highlightedLinkCount(), 0);
});

test('schedule() while disabled is a no-op (no RAF queued)', () => {
  const { sc } = makeSc();
  rafQueue = [];
  sc.schedule({ robot: undefined as never, metadata: undefined as never, semantic: { disableCollisions: [] } });
  assert.equal(rafQueue.length, 0, 'schedule must not queue when disabled');
});

test('setEnabled(false) does not enqueue anything', () => {
  const { sc } = makeSc();
  rafQueue = [];
  sc.setEnabled(undefined, false);
  assert.equal(rafQueue.length, 0);
});

// =============================================================================
// Debounce (leading + trailing edge)
// =============================================================================

function ctxStub() {
  // The narrow-phase needs robot.updateMatrixWorld(); the index is empty so
  // we never reach the BVH path. metadata.links/joints are read by
  // isAdjacent — empty objects are fine.
  return {
    robot: { updateMatrixWorld: () => {} } as never,
    metadata: { links: {}, joints: {} } as never,
    semantic: { disableCollisions: [] }
  };
}

test('schedule() coalesces multiple calls into one RAF (leading edge)', () => {
  const { sc } = makeSc();
  rafQueue = [];
  sc.setEnabled(ctxStub(), true); // runs once synchronously to show state
  // Two extra calls before the RAF fires:
  sc.schedule(ctxStub());
  sc.schedule(ctxStub());
  sc.schedule(ctxStub());
  // Only one RAF was queued total.
  assert.equal(rafQueue.length, 1, `expected 1 RAF queued, got ${rafQueue.length}`);
  flushRaf();
});

test('schedule() during a pending RAF re-arms a trailing-edge run', () => {
  const { sc } = makeSc();
  rafQueue = [];
  sc.setEnabled(ctxStub(), true);
  sc.schedule(ctxStub());            // first RAF scheduled
  assert.equal(rafQueue.length, 1);
  // Mid-flight: another schedule() comes in.
  sc.schedule(ctxStub());
  // Fire just the currently-queued RAF (one frame).
  const firedFirst = fireOneFrame();
  assert.equal(firedFirst, 1, 'exactly one frame should have been pending');
  // The trailing-edge re-arm should have queued a second RAF for the next frame.
  assert.equal(rafQueue.length, 1, 'trailing edge must queue a follow-up RAF');
  const firedSecond = fireOneFrame();
  assert.equal(firedSecond, 1, 'trailing-edge RAF must fire');
  assert.equal(rafQueue.length, 0, 'no further RAFs after the trailing edge fires');
});

test('schedule() after the RAF has fired enqueues a fresh one (not the same)', () => {
  const { sc } = makeSc();
  rafQueue = [];
  sc.setEnabled(ctxStub(), true);
  sc.schedule(ctxStub());
  flushRaf();
  // Settled — now a fresh schedule starts a new RAF cycle.
  sc.schedule(ctxStub());
  assert.equal(rafQueue.length, 1);
  flushRaf();
});

test('schedule() does NOT re-arm when disabled is flipped during the RAF', () => {
  const { sc } = makeSc();
  rafQueue = [];
  sc.setEnabled(ctxStub(), true);
  sc.schedule(ctxStub());
  // Disable before the RAF fires.
  sc.setEnabled(undefined, false);
  flushRaf();
  // The disabled flag must short-circuit the RAF handler — and there must
  // be no re-arm afterwards.
  assert.equal(rafQueue.length, 0);
});

// =============================================================================
// State change callbacks + redraw
// =============================================================================

test('setEnabled(true) triggers a state-change notification', () => {
  const ctx = makeSc();
  ctx.sc.setEnabled(ctxStub(), true);
  assert.ok(ctx.stateChanges > 0);
});

test('setEnabled(false) clears highlights and notifies', () => {
  const ctx = makeSc();
  ctx.sc.setEnabled(ctxStub(), true);
  const baselineRedraws = ctx.redraws;
  ctx.sc.setEnabled(undefined, false);
  // clearHighlights -> applyHighlights -> requestRedraw fires at least once.
  assert.ok(ctx.redraws >= baselineRedraws);
});

test('dispose() returns the feature to a clean idle state', () => {
  const ctx = makeSc();
  ctx.sc.setEnabled(ctxStub(), true);
  ctx.sc.dispose();
  assert.equal(ctx.sc.hasGeometryIndex(), false);
  assert.equal(ctx.sc.highlightedLinkCount(), 0);
});

// =============================================================================
// computeCollisions (used by the Tools-panel collision-pair sampler)
// =============================================================================

test('computeCollisions returns empty pairs/links when no index has been built', () => {
  const { sc } = makeSc();
  const result = sc.computeCollisions(ctxStub());
  assert.deepEqual(result.pairs, []);
  assert.equal(result.links.size, 0);
});

test('computeCollisions does NOT flip the feature into enabled state', () => {
  const { sc } = makeSc();
  sc.computeCollisions(ctxStub());
  assert.equal(sc.isEnabled(), false);
});

// =============================================================================
// Geometry: real meshes, indexed by owning link
// =============================================================================

import * as THREE from 'three';
import { computeBoundsTree } from 'three-mesh-bvh';
import { linkGeometry } from '../../src/renderer/features/selfCollision';

(THREE.BufferGeometry.prototype as unknown as { computeBoundsTree: typeof computeBoundsTree }).computeBoundsTree = computeBoundsTree;

/** A chain base → a → b → c of unit boxes, built the way urdf-loader builds
 *  it: links contain their <collision> groups; child links hang off joints. */
function boxChain(options: { namedColliders: boolean; cAt: [number, number, number] }) {
  const links: Record<string, THREE.Object3D> = {};
  const makeLink = (name: string, colliderName?: string) => {
    const link = Object.assign(new THREE.Object3D(), { isURDFLink: true });
    const collider = Object.assign(new THREE.Group(), { isURDFCollider: true });
    if (colliderName) collider.name = colliderName;
    collider.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshStandardMaterial()));
    link.add(collider);
    links[name] = link;
    return link;
  };
  const attach = (parent: THREE.Object3D, child: THREE.Object3D, x: number, y: number, z: number) => {
    const joint = Object.assign(new THREE.Object3D(), { isURDFJoint: true });
    joint.position.set(x, y, z);
    joint.add(child);
    parent.add(joint);
  };
  const named = (link: string) => options.namedColliders ? `${link}_collision` : undefined;
  const base = makeLink('base', named('base'));
  const a = makeLink('a', named('a'));
  const b = makeLink('b', named('b'));
  const c = makeLink('c', named('c'));
  // Adjacent links overlap at their joints (0.8 apart, boxes are 1 wide).
  attach(base, a, 0.8, 0, 0);
  attach(a, b, 0.8, 0, 0);
  attach(b, c, ...options.cAt);
  const robot = Object.assign(new THREE.Object3D(), { links, updateMatrixWorld: THREE.Object3D.prototype.updateMatrixWorld });
  robot.add(base);
  const metadata = {
    links: {
      base: { name: 'base', childJoints: ['ja'] },
      a: { name: 'a', parentJoint: 'ja', childJoints: ['jb'] },
      b: { name: 'b', parentJoint: 'jb', childJoints: ['jc'] },
      c: { name: 'c', parentJoint: 'jc', childJoints: [] }
    },
    joints: {
      ja: { name: 'ja', parent: 'base', child: 'a' },
      jb: { name: 'jb', parent: 'a', child: 'b' },
      jc: { name: 'jc', parent: 'b', child: 'c' }
    }
  };
  return { robot: robot as never, metadata: metadata as never, semantic: { disableCollisions: [] } };
}

for (const namedColliders of [false, true]) {
  test(`collisions are reported by link name and skip adjacent links (${namedColliders ? 'named' : 'unnamed'} <collision>)`, () => {
    const { sc } = makeSc();
    // c folds back onto base: base↔c really overlap; every adjacent pair
    // touches at its joint and must be ignored.
    const ctx = boxChain({ namedColliders, cAt: [-2.0, 0, 0] });
    sc.rebuildIndex(ctx.robot);
    assert.deepEqual([...sc.linksWithCollisionGeometry()].sort(), ['a', 'b', 'base', 'c']);
    const result = sc.computeCollisions(ctx);
    assert.deepEqual(result.pairs.map(pair => [...pair].sort().join('|')), ['base|c']);
  });
}

test('a pose with no real contact reports no collisions despite touching neighbours', () => {
  const { sc } = makeSc();
  const ctx = boxChain({ namedColliders: true, cAt: [0.8, 0, 0] });
  sc.rebuildIndex(ctx.robot);
  assert.deepEqual(sc.computeCollisions(ctx).pairs, []);
});

test('linkGeometry finds a link\'s own groups but not its descendants\'', () => {
  const ctx = boxChain({ namedColliders: false, cAt: [0.8, 0, 0] });
  const groups = linkGeometry(ctx.robot, 'isURDFCollider');
  assert.equal(groups.size, 4);
  for (const list of groups.values()) assert.equal(list.length, 1);
});

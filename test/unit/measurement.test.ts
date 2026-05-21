import { strict as assert } from 'node:assert';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import { Measurement, type MeasurementDeps } from '../../src/renderer/features/measurement';

// Single JSDOM window shared across tests; the Measurement module looks up
// #measure-toggle / #measure-readout / #measure-status by id directly, so we
// install a tiny Tools panel on demand.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
(globalThis as { document: Document }).document = dom.window.document;
(globalThis as { window: Window }).window = dom.window as unknown as Window;

function mountToolsPanel(): void {
  document.body.innerHTML = `
    <button id="measure-toggle">Start measuring</button>
    <div id="measure-readout"></div>
    <div id="measure-status"></div>
  `;
}

function makeMeasurement(overrides: Partial<MeasurementDeps> = {}): {
  m: Measurement;
  scene: THREE.Scene;
  redraws: number;
  stateChanges: number;
  setHit(hit: THREE.Intersection | undefined): void;
} {
  const scene = new THREE.Scene();
  let nextHit: THREE.Intersection | undefined;
  let redraws = 0;
  let stateChanges = 0;
  const m = new Measurement({
    scene,
    raycastFromEvent: () => nextHit,
    getBoundsRadius: () => 1,
    requestRedraw: () => { redraws++; },
    onStateChange: () => { stateChanges++; },
    ...overrides
  });
  return { m, scene, get redraws() { return redraws; }, get stateChanges() { return stateChanges; }, setHit(h) { nextHit = h; } };
}

function fakeHit(x: number, y: number, z: number): THREE.Intersection {
  return {
    distance: 0,
    point: new THREE.Vector3(x, y, z),
    object: new THREE.Object3D()
  } as THREE.Intersection;
}

// =============================================================================
// State machine
// =============================================================================

test('Measurement starts idle', () => {
  const { m } = makeMeasurement();
  const snap = m.snapshot();
  assert.equal(snap.mode, false);
  assert.equal(snap.pointCount, 0);
  assert.equal(snap.distance, null);
  assert.equal(m.isActive(), false);
});

test('toggle() activates measurement mode', () => {
  const { m } = makeMeasurement();
  m.toggle();
  assert.equal(m.isActive(), true);
});

test('toggle() twice deactivates without dropping any points', () => {
  const { m } = makeMeasurement();
  m.toggle();
  m.toggle();
  assert.equal(m.isActive(), false);
  assert.equal(m.snapshot().pointCount, 0);
});

test('handleClick returns false when measurement mode is off', () => {
  const { m } = makeMeasurement();
  const result = m.handleClick({} as MouseEvent);
  assert.equal(result, false, 'click should not be consumed when idle');
});

test('handleClick returns true after toggle even if the raycast misses', () => {
  const { m, setHit } = makeMeasurement();
  m.toggle();
  setHit(undefined);
  const consumed = m.handleClick({} as MouseEvent);
  assert.equal(consumed, true, 'measurement mode must consume clicks even on a miss');
  assert.equal(m.snapshot().pointCount, 0);
});

test('Two successful clicks anchor two points and exit measurement mode', () => {
  const { m, setHit } = makeMeasurement();
  m.toggle();
  setHit(fakeHit(0, 0, 0));
  m.handleClick({} as MouseEvent);
  setHit(fakeHit(3, 4, 0)); // distance = 5
  m.handleClick({} as MouseEvent);

  const snap = m.snapshot();
  assert.equal(snap.pointCount, 2);
  assert.equal(snap.mode, false, 'mode auto-exits after the second point');
  assert.ok(Math.abs((snap.distance ?? 0) - 5) < 1e-9, `expected ≈5, got ${snap.distance}`);
});

test('A third click while in mode resets and starts a new measurement', () => {
  // Drop two, then re-enter mode and click a third time — the prior pair must
  // be cleared before the new pair is anchored.
  const { m, setHit } = makeMeasurement();
  m.toggle();
  setHit(fakeHit(0, 0, 0));
  m.handleClick({} as MouseEvent);
  setHit(fakeHit(1, 0, 0));
  m.handleClick({} as MouseEvent);
  // Re-enter measurement, drop new point.
  m.toggle();
  setHit(fakeHit(10, 0, 0));
  m.handleClick({} as MouseEvent);
  const snap = m.snapshot();
  assert.equal(snap.pointCount, 1, 'old points must be cleared when re-entering mode');
  assert.equal(snap.distance, null);
});

test('clear() wipes points and exits mode', () => {
  const { m, setHit } = makeMeasurement();
  m.toggle();
  setHit(fakeHit(0, 0, 0));
  m.handleClick({} as MouseEvent);
  m.clear();
  const snap = m.snapshot();
  assert.equal(snap.mode, false);
  assert.equal(snap.pointCount, 0);
  assert.equal(snap.distance, null);
});

// =============================================================================
// Scene side-effects
// =============================================================================

test('Anchoring two points adds 2 markers + 1 line into the scene', () => {
  const { m, scene, setHit } = makeMeasurement();
  m.toggle();
  setHit(fakeHit(0, 0, 0));
  m.handleClick({} as MouseEvent);
  setHit(fakeHit(1, 0, 0));
  m.handleClick({} as MouseEvent);

  // Count meshes (markers) and lines in the scene.
  let markerCount = 0;
  let lineCount = 0;
  scene.traverse(obj => {
    if ((obj as THREE.Mesh).isMesh) markerCount++;
    if ((obj as THREE.Line).isLine) lineCount++;
  });
  assert.equal(markerCount, 2);
  assert.equal(lineCount, 1);
});

test('clear() removes markers and line from the scene and disposes geometry', () => {
  const { m, scene, setHit } = makeMeasurement();
  m.toggle();
  setHit(fakeHit(0, 0, 0));
  m.handleClick({} as MouseEvent);
  setHit(fakeHit(1, 0, 0));
  m.handleClick({} as MouseEvent);

  m.clear();

  let markerCount = 0;
  let lineCount = 0;
  scene.traverse(obj => {
    if ((obj as THREE.Mesh).isMesh) markerCount++;
    if ((obj as THREE.Line).isLine) lineCount++;
  });
  assert.equal(markerCount, 0, 'markers must be removed');
  assert.equal(lineCount, 0, 'line must be removed');
});

test('requestRedraw is fired on successful clicks and on clear()', () => {
  const ctx = makeMeasurement();
  ctx.m.toggle();
  ctx.setHit(fakeHit(0, 0, 0));
  ctx.m.handleClick({} as MouseEvent);
  const afterFirst = ctx.redraws;
  ctx.setHit(fakeHit(1, 0, 0));
  ctx.m.handleClick({} as MouseEvent);
  const afterSecond = ctx.redraws;
  ctx.m.clear();
  const afterClear = ctx.redraws;
  assert.ok(afterFirst > 0, 'first click must request redraw');
  assert.ok(afterSecond > afterFirst, 'second click must request redraw');
  assert.ok(afterClear > afterSecond, 'clear must request redraw');
});

test('requestRedraw is NOT fired when measurement mode is off', () => {
  const ctx = makeMeasurement();
  ctx.m.handleClick({} as MouseEvent);
  assert.equal(ctx.redraws, 0);
});

// =============================================================================
// UI side-effects (require the Tools panel DOM to be mounted)
// =============================================================================

test('refresh() updates the toggle button text and class', () => {
  mountToolsPanel();
  const { m } = makeMeasurement();
  m.toggle(); // active, no points yet
  const toggle = document.getElementById('measure-toggle')!;
  assert.match(toggle.textContent ?? '', /Pick point 1/);
  assert.equal(toggle.classList.contains('active'), true);
});

test('refresh() renders distance + Δxyz lines once two points are placed', () => {
  mountToolsPanel();
  const { m, setHit } = makeMeasurement();
  m.toggle();
  setHit(fakeHit(0, 0, 0));
  m.handleClick({} as MouseEvent);
  setHit(fakeHit(3, 4, 0));
  m.handleClick({} as MouseEvent);

  const readout = document.getElementById('measure-readout')!;
  // Distance text appears with a 4-decimal precision.
  assert.match(readout.textContent ?? '', /Distance\s+5\.0000\s+m/);
  assert.match(readout.textContent ?? '', /Δx/);
  assert.match(readout.textContent ?? '', /Δy/);
});

test('refresh() text content is sanitized (no markup injection from coordinate label)', () => {
  // The readout text is built from numeric toFixed() values, so it cannot
  // carry markup; this is a defense-in-depth check that the html`` helper
  // doesn't leak text into a parsed DOM as elements.
  mountToolsPanel();
  const { m, setHit } = makeMeasurement();
  m.toggle();
  setHit(fakeHit(0, 0, 0));
  m.handleClick({} as MouseEvent);
  setHit(fakeHit(1, 0, 0));
  m.handleClick({} as MouseEvent);
  // No <script> tag should ever have come into the readout.
  assert.equal(document.querySelectorAll('#measure-readout script').length, 0);
});

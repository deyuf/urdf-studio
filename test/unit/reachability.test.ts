import { strict as assert } from 'node:assert';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import * as THREE from 'three';
import URDFLoader from 'urdf-loader';
import type { URDFRobot } from 'urdf-loader/src/URDFClasses';
import '../../src/core/io.node';
import { analyzeUrdf } from '../../src/core/urdfAnalysis';
import { Reachability, type ReachabilityDeps } from '../../src/renderer/features/reachability';
import {
  buildDexterityMap,
  directionBin,
  DIRECTION_BINS,
  extractChain,
  sampleChainRange,
  type ChainSamples
} from '../../src/renderer/logic/reachMap';

const dom = new JSDOM('<!doctype html><html><body><div id="reach-status"></div><div id="reach-legend" hidden><span id="reach-legend-max"></span></div></body></html>');
Object.assign(globalThis, {
  document: dom.window.document,
  window: dom.window,
  DOMParser: dom.window.DOMParser,
  Document: dom.window.Document,
  Element: dom.window.Element
});

// A small arm exercising everything the fast kinematics must match:
// rotated joint origins, a non-unit axis, continuous and prismatic joints,
// a chained mimic joint, a fixed tool frame and a static sensor link.
const ARM = `<robot name="arm">
  <link name="base"/><link name="l1"/><link name="l2"/><link name="l3"/><link name="l4"/>
  <link name="finger"/><link name="tcp"/><link name="camera"/>
  <joint name="j1" type="revolute"><parent link="base"/><child link="l1"/>
    <origin xyz="0 0 0.3" rpy="0 0 0.4"/><axis xyz="0 0 1"/><limit lower="-2.5" upper="2.5" effort="1" velocity="1"/></joint>
  <joint name="j2" type="revolute"><parent link="l1"/><child link="l2"/>
    <origin xyz="0.05 0 0.1" rpy="1.5708 0 0"/><axis xyz="0 2 0"/><limit lower="-1.5" upper="1.5" effort="1" velocity="1"/></joint>
  <joint name="j3" type="continuous"><parent link="l2"/><child link="l3"/>
    <origin xyz="0 0.4 0" rpy="0.2 -0.3 0.1"/><axis xyz="1 0 0"/></joint>
  <joint name="slide" type="prismatic"><parent link="l3"/><child link="l4"/>
    <origin xyz="0.3 0 0" rpy="0 0.5 0"/><axis xyz="1 0 0"/><limit lower="0" upper="0.2" effort="1" velocity="1"/></joint>
  <joint name="wrist" type="revolute"><parent link="l4"/><child link="finger"/>
    <origin xyz="0.1 0 0" rpy="0 0 0"/><axis xyz="0 1 0"/><limit lower="-1" upper="1" effort="1" velocity="1"/>
    <mimic joint="j3" multiplier="0.5" offset="0.1"/></joint>
  <joint name="tool" type="fixed"><parent link="finger"/><child link="tcp"/>
    <origin xyz="0 0 0.12" rpy="0.3 0 0"/></joint>
  <joint name="cam" type="fixed"><parent link="base"/><child link="camera"/>
    <origin xyz="0.2 0 0.1" rpy="0 0 0"/></joint>
</robot>`;

function loadArm(): { robot: URDFRobot; holder: THREE.Group } {
  const loader = new URDFLoader();
  const robot = loader.parse(ARM) as URDFRobot;
  // Place the robot under a Z-up → Y-up wrapper, like the renderer does.
  const holder = new THREE.Group();
  holder.rotation.x = -Math.PI / 2;
  holder.position.set(0.5, 0, -0.2);
  holder.add(robot as unknown as THREE.Object3D);
  holder.updateMatrixWorld(true);
  return { robot, holder };
}

const metadata = analyzeUrdf(ARM, '/arm.urdf', {});

function sequence(values: number[]): () => number {
  let index = 0;
  return () => values[index++ % values.length];
}

test('fast kinematics matches the robot scene graph, including mimic, prismatic and a placed robot', () => {
  const { robot } = loadArm();
  const chain = extractChain(robot, metadata, 'tcp');
  assert.ok(chain);
  assert.deepEqual(chain!.variables.map(v => v.name), ['j1', 'j2', 'j3', 'slide']);
  // The sampler ignores limits on mimic followers, as the old sampler did.
  Object.values(robot.joints).forEach(joint => { joint.ignoreLimits = true; });

  for (let trial = 0; trial < 25; trial += 1) {
    const draws = chain!.variables.map(() => Math.random());
    const samples: ChainSamples = { count: 1, positions: new Float32Array(3), bins: new Uint8Array(1) };
    sampleChainRange(chain!, samples, 0, 1, sequence(draws));

    chain!.variables.forEach((variable, i) => {
      robot.setJointValue(variable.name, variable.lower + draws[i] * (variable.upper - variable.lower));
    });
    (robot as unknown as THREE.Object3D).updateMatrixWorld(true);
    const tcp = robot.links.tcp;
    const expected = tcp.getWorldPosition(new THREE.Vector3());
    const z = new THREE.Vector3(0, 0, 1).transformDirection(tcp.matrixWorld);

    assert.ok(Math.abs(samples.positions[0] - expected.x) < 1e-5, `x ${samples.positions[0]} vs ${expected.x}`);
    assert.ok(Math.abs(samples.positions[1] - expected.y) < 1e-5, `y ${samples.positions[1]} vs ${expected.y}`);
    assert.ok(Math.abs(samples.positions[2] - expected.z) < 1e-5, `z ${samples.positions[2]} vs ${expected.z}`);
    assert.equal(samples.bins[0], directionBin(z.x, z.y, z.z));
  }
});

test('extractChain treats a link no joint moves as a fixed point', () => {
  const { robot } = loadArm();
  const chain = extractChain(robot, metadata, 'camera');
  assert.ok(chain);
  assert.equal(chain!.steps.length, 0);
  assert.equal(extractChain(robot, metadata, 'nope'), undefined);
});

test('directionBin uses every bin and separates opposite directions', () => {
  const seen = new Set<number>();
  const n = 2000;
  for (let i = 0; i < n; i += 1) {
    // Fibonacci sphere
    const y = 1 - (2 * (i + 0.5)) / n;
    const r = Math.sqrt(1 - y * y);
    const phi = i * Math.PI * (3 - Math.sqrt(5));
    const x = Math.cos(phi) * r;
    const z = Math.sin(phi) * r;
    const bin = directionBin(x, y, z);
    assert.ok(bin >= 0 && bin < DIRECTION_BINS);
    assert.notEqual(bin, directionBin(-x, -y, -z));
    seen.add(bin);
  }
  assert.equal(seen.size, DIRECTION_BINS);
});

test('buildDexterityMap counts distinct directions per voxel and sorts best first', () => {
  // Voxel A (near origin) is reached from every direction bin; voxel B (1 m
  // away) only ever from bin 3, however many samples land there.
  const count = DIRECTION_BINS + 50;
  const samples: ChainSamples = { count, positions: new Float32Array(count * 3), bins: new Uint8Array(count) };
  for (let i = 0; i < DIRECTION_BINS; i += 1) {
    samples.bins[i] = i;
  }
  for (let i = DIRECTION_BINS; i < count; i += 1) {
    samples.positions.set([1, 0, 0], i * 3);
    samples.bins[i] = 3;
  }
  const map = buildDexterityMap(samples, 8);
  assert.equal(map.count, 2);
  assert.equal(map.dexterity[0], 1);
  assert.ok(Math.abs(map.dexterity[1] - 1 / DIRECTION_BINS) < 1e-6);
  assert.ok(map.centers[0] < 0.2, 'best voxel is the one at the origin');
  assert.ok(map.centers[3] > 0.8);
  assert.ok(Math.abs(map.voxelSize - 1 / 8) < 1e-9);
});

// =============================================================================
// Reachability feature
// =============================================================================

function makeReachability(overrides: Partial<ReachabilityDeps> = {}) {
  const scene = new THREE.Scene();
  let redraws = 0;
  let lastFitBox: THREE.Box3 | undefined;
  const r = new Reachability({
    scene,
    fitCameraToBox: box => { lastFitBox = box; },
    requestRedraw: () => { redraws++; },
    ...overrides
  });
  return {
    r, scene,
    get redraws() { return redraws; },
    get lastFitBox() { return lastFitBox; }
  };
}

function pointsIn(scene: THREE.Scene): THREE.Points[] {
  const found: THREE.Points[] = [];
  scene.traverse(obj => { if ((obj as THREE.Points).isPoints) found.push(obj as THREE.Points); });
  return found;
}

const status = () => document.getElementById('reach-status')!.textContent ?? '';

test('Reachability starts empty and dispose() on an empty cloud does not redraw', () => {
  const ctx = makeReachability();
  assert.equal(ctx.r.isVisible(), false);
  assert.equal(ctx.r.pointCount(), 0);
  ctx.r.dispose();
  assert.equal(ctx.redraws, 0);
});

test('sample() rejects an unknown tip link and a robot without movable joints', async () => {
  const { r } = makeReachability();
  const { robot } = loadArm();
  assert.equal(await r.sample({ robot, metadata, tipLinkName: 'no_such_tip', sampleCount: 10 }), undefined);
  assert.match(status(), /Pick a valid tip link/);
  const still = { ...metadata, movableJointNames: [] };
  assert.equal(await r.sample({ robot, metadata: still, tipLinkName: 'tcp', sampleCount: 10 }), undefined);
  assert.match(status(), /No movable joints/);
});

test('sample() draws a dexterity map without moving the robot', async () => {
  const ctx = makeReachability();
  const { robot } = loadArm();
  robot.setJointValue('j1', 0.7);
  const before = robot.links.tcp.getWorldPosition(new THREE.Vector3());
  const result = await ctx.r.sample({ robot, metadata, tipLinkName: 'tcp', sampleCount: 20000 });
  assert.ok(result);
  assert.equal(result!.sampleCount, 20000);
  assert.ok(result!.voxelCount > 50, `expected many voxels, got ${result!.voxelCount}`);
  assert.ok(result!.maxDexterity > 0.3, 'some voxels are reached from many directions');
  assert.equal(ctx.r.pointCount(), result!.voxelCount);
  assert.equal(pointsIn(ctx.scene).length, 1);
  assert.equal(robot.joints.j1.angle, 0.7, 'joint values untouched');
  (robot as unknown as THREE.Object3D).updateMatrixWorld(true);
  assert.ok(robot.links.tcp.getWorldPosition(new THREE.Vector3()).distanceTo(before) < 1e-9);
  assert.match(status(), /20,000 samples in .* voxels of/);
  assert.equal(document.getElementById('reach-legend')!.hidden, false);
  assert.match(document.getElementById('reach-legend-max')!.textContent ?? '', new RegExp(`of ${DIRECTION_BINS}$`));
  assert.ok(ctx.lastFitBox && !ctx.lastFitBox.isEmpty());
});

test('setMinimumShare() hides low-dexterity voxels by draw range only', async () => {
  const { r } = makeReachability();
  const { robot } = loadArm();
  const result = await r.sample({ robot, metadata, tipLinkName: 'tcp', sampleCount: 20000 });
  const all = r.pointCount();
  r.setMinimumShare(0.9);
  const few = r.pointCount();
  assert.ok(few >= 1 && few < all, `${few} of ${all}`);
  r.setMinimumShare(0);
  assert.equal(r.pointCount(), result!.voxelCount);
});

test('sampling again replaces the map, and dispose() removes it', async () => {
  const { r, scene } = makeReachability();
  const { robot } = loadArm();
  await r.sample({ robot, metadata, tipLinkName: 'tcp', sampleCount: 5000 });
  await r.sample({ robot, metadata, tipLinkName: 'l2', sampleCount: 5000 });
  assert.equal(pointsIn(scene).length, 1);
  r.dispose();
  assert.equal(pointsIn(scene).length, 0);
  assert.equal(r.pointCount(), 0);
  assert.equal(status(), '');
  assert.equal(document.getElementById('reach-legend')!.hidden, true);
});

test('dispose() during a sweep cancels it', async () => {
  const { r, scene } = makeReachability();
  const { robot } = loadArm();
  const pending = r.sample({ robot, metadata, tipLinkName: 'tcp', sampleCount: 1_000_000 });
  await new Promise(resolve => setTimeout(resolve, 0));
  r.dispose();
  assert.equal(await pending, undefined);
  assert.equal(pointsIn(scene).length, 0);
});

test('sample() explains a tip that no joint moves', async () => {
  const { r } = makeReachability();
  const { robot } = loadArm();
  await r.sample({ robot, metadata, tipLinkName: 'camera', sampleCount: 200 });
  assert.match(status(), /"camera" does not move with any joint/);
});

test('sampling is fast: 200k samples of a 4-joint chain well under a second of compute', () => {
  const { robot } = loadArm();
  const chain = extractChain(robot, metadata, 'tcp')!;
  const count = 200_000;
  const samples: ChainSamples = { count, positions: new Float32Array(count * 3), bins: new Uint8Array(count) };
  const start = performance.now();
  sampleChainRange(chain, samples, 0, count);
  buildDexterityMap(samples);
  const elapsed = performance.now() - start;
  assert.ok(elapsed < 1500, `took ${elapsed.toFixed(0)} ms`);
});

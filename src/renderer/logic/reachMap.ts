// Fast reachability sampling and the dexterity (orientation-coverage) map.
//
// The scene graph is far too slow for workspace sampling: every
// setJointValue + updateMatrixWorld walks the whole robot, meshes included.
// Instead we pull out the single chain of transforms from the robot root to
// the tip link once, then run forward kinematics on plain Float64Arrays.
// Only joints on that chain are evaluated, static segments are pre-multiplied
// together, and the robot object is never touched while sampling.
//
// Each sample yields the tip position and its approach direction (the tip
// frame's +Z axis — the ROS convention for tool frames). Samples are binned
// into voxels; a voxel's dexterity is the share of approach directions, out of
// DIRECTION_BINS evenly spread over the sphere, that reached it. That is the
// "reachability index" used by capability / reachability maps in the
// literature, and it does not depend on how many samples happen to land in a
// voxel once the voxel is well covered.

import * as THREE from 'three';
import type { URDFRobot } from 'urdf-loader/src/URDFClasses';
import type { RobotMetadata } from '../../core/types';
import { jointRange } from './displayGroups';

/** Row-major 3×4 rigid transform: rotation columns then translation. */
type Mat34 = Float64Array;

interface MotionStep {
  /** Static transform from the previous moving frame to this joint's origin. */
  pre: Mat34;
  prismatic: boolean;
  axis: [number, number, number];
  variable: number;
  multiplier: number;
  offset: number;
}

export interface KinematicChain {
  /** World transform of the chain's root (includes the robot's own placement). */
  base: Mat34;
  steps: MotionStep[];
  /** Static transform from the last moving joint to the tip link. */
  post: Mat34;
  /** Independent joints sampled; mimic joints are expressed through these. */
  variables: Array<{ name: string; lower: number; upper: number }>;
}

/** Faces × cells per face. 2×2 cells per cube face gives 24 bins of ~0.52 sr. */
const CELLS_PER_FACE = 2;
export const DIRECTION_BINS = 6 * CELLS_PER_FACE * CELLS_PER_FACE;

// ---------------------------------------------------------------------------
// Chain extraction
// ---------------------------------------------------------------------------

interface JointLike extends THREE.Object3D {
  isURDFJoint?: boolean;
  jointType?: string;
  axis?: THREE.Vector3;
  origPosition?: THREE.Vector3 | null;
  origQuaternion?: THREE.Quaternion | null;
}

/**
 * Build the kinematic chain from the robot root to `tipLinkName`. Returns
 * undefined when the link is not part of the robot.
 */
export function extractChain(robot: URDFRobot, metadata: RobotMetadata, tipLinkName: string): KinematicChain | undefined {
  const tip = robot.links?.[tipLinkName] as THREE.Object3D | undefined;
  if (!tip) {
    return undefined;
  }
  const path: THREE.Object3D[] = [];
  let node: THREE.Object3D | null = tip;
  while (node && node !== (robot as unknown as THREE.Object3D)) {
    path.push(node);
    node = node.parent;
  }
  if (node !== (robot as unknown as THREE.Object3D)) {
    return undefined;
  }
  path.reverse();

  (robot as unknown as THREE.Object3D).updateMatrixWorld(true);
  const movable = new Set(metadata.movableJointNames);
  const variables: KinematicChain['variables'] = [];
  const variableIndex = new Map<string, number>();
  const steps: MotionStep[] = [];
  let pending = identity();

  for (const object of path) {
    const joint = object as JointLike;
    const moves = joint.isURDFJoint && (joint.jointType === 'revolute' || joint.jointType === 'continuous' || joint.jointType === 'prismatic');
    const driver = moves ? resolveDriver(joint.name, metadata, movable) : undefined;
    if (!moves || !driver) {
      pending = multiply(pending, fromMatrix4(object.matrix));
      continue;
    }
    let variable = variableIndex.get(driver.name);
    if (variable === undefined) {
      const [lower, upper] = jointRange(metadata.joints[driver.name]);
      variable = variables.length;
      variables.push({ name: driver.name, lower, upper });
      variableIndex.set(driver.name, variable);
    }
    const origin = new THREE.Matrix4().compose(
      joint.origPosition ?? joint.position,
      joint.origQuaternion ?? joint.quaternion,
      joint.scale
    );
    const axis = (joint.axis ?? new THREE.Vector3(1, 0, 0)).clone();
    if (axis.lengthSq() < 1e-12) {
      axis.set(1, 0, 0);
    }
    axis.normalize();
    steps.push({
      pre: multiply(pending, fromMatrix4(origin)),
      prismatic: joint.jointType === 'prismatic',
      axis: [axis.x, axis.y, axis.z],
      variable,
      multiplier: driver.multiplier,
      offset: driver.offset
    });
    pending = identity();
  }

  return {
    base: fromMatrix4((robot as unknown as THREE.Object3D).matrixWorld),
    steps,
    post: pending,
    variables
  };
}

/** Follow mimic links to the independent joint that drives `name`. */
function resolveDriver(
  name: string,
  metadata: RobotMetadata,
  movable: Set<string>
): { name: string; multiplier: number; offset: number } | undefined {
  let current = name;
  let multiplier = 1;
  let offset = 0;
  const seen = new Set<string>();
  for (;;) {
    if (seen.has(current)) {
      return undefined; // mimic cycle: leave the joint where it is
    }
    seen.add(current);
    const mimic = metadata.joints[current]?.mimic;
    if (!mimic) {
      return movable.has(current) ? { name: current, multiplier, offset } : undefined;
    }
    // value(current) = m * value(master) + o, composed down the chain.
    offset += multiplier * mimic.offset;
    multiplier *= mimic.multiplier;
    current = mimic.joint;
  }
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

export interface ChainSamples {
  count: number;
  positions: Float32Array;
  /** Direction bin of the tip's +Z axis per sample. */
  bins: Uint8Array;
}

/**
 * Sample `count` uniformly random joint configurations into the given
 * buffers, starting at `start`. Split into ranges so callers can yield to
 * the event loop between chunks.
 */
export function sampleChainRange(
  chain: KinematicChain,
  out: ChainSamples,
  start: number,
  end: number,
  random: () => number = Math.random
): void {
  const { base, steps, post, variables } = chain;
  const values = new Float64Array(variables.length);
  const m = new Float64Array(12);
  const t = new Float64Array(12);
  for (let i = start; i < end; i += 1) {
    for (let v = 0; v < variables.length; v += 1) {
      const { lower, upper } = variables[v];
      values[v] = lower + random() * (upper - lower);
    }
    m.set(base);
    for (let s = 0; s < steps.length; s += 1) {
      const step = steps[s];
      multiplyInto(m, step.pre, t);
      m.set(t);
      const q = values[step.variable] * step.multiplier + step.offset;
      if (step.prismatic) {
        translateLocal(m, step.axis[0] * q, step.axis[1] * q, step.axis[2] * q);
      } else {
        rotateLocal(m, step.axis[0], step.axis[1], step.axis[2], q);
      }
    }
    multiplyInto(m, post, t);
    out.positions[i * 3] = t[3];
    out.positions[i * 3 + 1] = t[7];
    out.positions[i * 3 + 2] = t[11];
    out.bins[i] = directionBin(t[2], t[6], t[10]);
  }
}

/**
 * Index of the direction cell containing (x, y, z), out of DIRECTION_BINS.
 * Cube-map with an equal-angle warp, so cells are close to equal in area.
 */
export function directionBin(x: number, y: number, z: number): number {
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  const az = Math.abs(z);
  let face: number;
  let u: number;
  let v: number;
  if (ax >= ay && ax >= az) {
    face = x >= 0 ? 0 : 1;
    u = y / (ax || 1);
    v = z / (ax || 1);
  } else if (ay >= az) {
    face = y >= 0 ? 2 : 3;
    u = x / ay;
    v = z / ay;
  } else {
    face = z >= 0 ? 4 : 5;
    u = x / az;
    v = y / az;
  }
  return face * CELLS_PER_FACE * CELLS_PER_FACE + warpCell(u) * CELLS_PER_FACE + warpCell(v);
}

function warpCell(value: number): number {
  const warped = (Math.atan(value) * 4) / Math.PI; // [-1, 1], equal angle
  const cell = Math.floor(((warped + 1) / 2) * CELLS_PER_FACE);
  return cell < 0 ? 0 : cell >= CELLS_PER_FACE ? CELLS_PER_FACE - 1 : cell;
}

// ---------------------------------------------------------------------------
// Dexterity map
// ---------------------------------------------------------------------------

export interface DexterityMap {
  voxelSize: number;
  /** Voxel centres, sorted by dexterity, highest first. */
  centers: Float32Array;
  /** Fraction of DIRECTION_BINS reached in each voxel (0..1], same order. */
  dexterity: Float32Array;
  count: number;
  bounds: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
  /** Largest extent of the sampled positions, in metres. */
  extent: number;
}

/** Voxels along the longest side, scaled so busy voxels get enough samples. */
export function voxelDivisions(sampleCount: number): number {
  return Math.max(8, Math.min(40, Math.round(Math.cbrt(sampleCount / 25))));
}

export function buildDexterityMap(samples: ChainSamples, divisions = voxelDivisions(samples.count)): DexterityMap {
  const { positions, bins, count } = samples;
  let minX = Infinity, minY = Infinity, minZ = Infinity;
  let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i += 1) {
    const x = positions[i * 3], y = positions[i * 3 + 1], z = positions[i * 3 + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  const bounds = { minX, maxX, minY, maxY, minZ, maxZ };
  if (count === 0) {
    return { voxelSize: 0, centers: new Float32Array(0), dexterity: new Float32Array(0), count: 0, bounds, extent: 0 };
  }
  const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
  const voxelSize = Math.max(extent / divisions, 1e-4);
  const nx = Math.floor((maxX - minX) / voxelSize) + 1;
  const ny = Math.floor((maxY - minY) / voxelSize) + 1;
  const nz = Math.floor((maxZ - minZ) / voxelSize) + 1;

  // Dense cell → voxel lookup; the grid is at most (divisions + 1)^3 cells.
  const cellToVoxel = new Int32Array(nx * ny * nz).fill(-1);
  const masks: number[] = [];
  const cells: number[] = [];
  for (let i = 0; i < count; i += 1) {
    const ix = Math.min(nx - 1, Math.floor((positions[i * 3] - minX) / voxelSize));
    const iy = Math.min(ny - 1, Math.floor((positions[i * 3 + 1] - minY) / voxelSize));
    const iz = Math.min(nz - 1, Math.floor((positions[i * 3 + 2] - minZ) / voxelSize));
    const cell = ix + nx * (iy + ny * iz);
    let voxel = cellToVoxel[cell];
    if (voxel < 0) {
      voxel = masks.length;
      cellToVoxel[cell] = voxel;
      masks.push(0);
      cells.push(cell);
    }
    masks[voxel] |= 1 << bins[i];
  }

  const order = masks.map((mask, index) => ({ index, reached: popcount(mask) }));
  order.sort((a, b) => b.reached - a.reached);
  const centers = new Float32Array(order.length * 3);
  const dexterity = new Float32Array(order.length);
  order.forEach(({ index, reached }, rank) => {
    const cell = cells[index];
    const ix = cell % nx;
    const iy = Math.floor(cell / nx) % ny;
    const iz = Math.floor(cell / (nx * ny));
    centers[rank * 3] = minX + (ix + 0.5) * voxelSize;
    centers[rank * 3 + 1] = minY + (iy + 0.5) * voxelSize;
    centers[rank * 3 + 2] = minZ + (iz + 0.5) * voxelSize;
    dexterity[rank] = reached / DIRECTION_BINS;
  });
  return { voxelSize, centers, dexterity, count: order.length, bounds, extent };
}

function popcount(value: number): number {
  let v = value >>> 0;
  v -= (v >>> 1) & 0x55555555;
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  return (((v + (v >>> 4)) & 0x0f0f0f0f) * 0x01010101) >>> 24;
}

// ---------------------------------------------------------------------------
// Colour scale
// ---------------------------------------------------------------------------

// Viridis stops, starting above its near-black end so low values stay
// visible on a dark background. Perceptually ordered and colour-blind safe.
const SCALE: Array<[number, number, number]> = [
  [0.28, 0.17, 0.48],
  [0.19, 0.41, 0.56],
  [0.13, 0.57, 0.55],
  [0.21, 0.72, 0.47],
  [0.99, 0.91, 0.15]
];

export const DEXTERITY_GRADIENT = `linear-gradient(90deg, ${SCALE.map(([r, g, b], i) =>
  `rgb(${Math.round(r * 255)} ${Math.round(g * 255)} ${Math.round(b * 255)}) ${(i / (SCALE.length - 1)) * 100}%`).join(', ')})`;

/** Colour for t in [0, 1]. */
export function dexterityColor(t: number, out: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const clamped = t <= 0 ? 0 : t >= 1 ? 1 : t;
  const scaled = clamped * (SCALE.length - 1);
  const i = Math.min(SCALE.length - 2, Math.floor(scaled));
  const f = scaled - i;
  for (let c = 0; c < 3; c += 1) {
    out[c] = SCALE[i][c] + (SCALE[i + 1][c] - SCALE[i][c]) * f;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 3×4 matrix helpers
// ---------------------------------------------------------------------------

function identity(): Mat34 {
  return new Float64Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0]);
}

function fromMatrix4(matrix: THREE.Matrix4): Mat34 {
  const e = matrix.elements; // column-major
  return new Float64Array([e[0], e[4], e[8], e[12], e[1], e[5], e[9], e[13], e[2], e[6], e[10], e[14]]);
}

function multiply(a: Mat34, b: Mat34): Mat34 {
  const out = new Float64Array(12);
  multiplyInto(a, b, out);
  return out;
}

function multiplyInto(a: Mat34, b: Mat34, out: Mat34): void {
  for (let r = 0; r < 3; r += 1) {
    const a0 = a[r * 4], a1 = a[r * 4 + 1], a2 = a[r * 4 + 2], a3 = a[r * 4 + 3];
    out[r * 4] = a0 * b[0] + a1 * b[4] + a2 * b[8];
    out[r * 4 + 1] = a0 * b[1] + a1 * b[5] + a2 * b[9];
    out[r * 4 + 2] = a0 * b[2] + a1 * b[6] + a2 * b[10];
    out[r * 4 + 3] = a0 * b[3] + a1 * b[7] + a2 * b[11] + a3;
  }
}

/** m ← m · Rot(axis, angle), axis normalised. */
function rotateLocal(m: Mat34, x: number, y: number, z: number, angle: number): void {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  const k = 1 - c;
  const r00 = c + x * x * k, r01 = x * y * k - z * s, r02 = x * z * k + y * s;
  const r10 = y * x * k + z * s, r11 = c + y * y * k, r12 = y * z * k - x * s;
  const r20 = z * x * k - y * s, r21 = z * y * k + x * s, r22 = c + z * z * k;
  for (let r = 0; r < 3; r += 1) {
    const a0 = m[r * 4], a1 = m[r * 4 + 1], a2 = m[r * 4 + 2];
    m[r * 4] = a0 * r00 + a1 * r10 + a2 * r20;
    m[r * 4 + 1] = a0 * r01 + a1 * r11 + a2 * r21;
    m[r * 4 + 2] = a0 * r02 + a1 * r12 + a2 * r22;
  }
}

/** m ← m · Trans(x, y, z). */
function translateLocal(m: Mat34, x: number, y: number, z: number): void {
  for (let r = 0; r < 3; r += 1) {
    m[r * 4 + 3] += m[r * 4] * x + m[r * 4 + 1] * y + m[r * 4 + 2] * z;
  }
}

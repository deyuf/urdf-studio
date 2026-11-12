// Pure helpers behind the reachability report: orthographic views of the
// dexterity map, summary figures and the CSV export. No THREE, no DOM.

import { DIRECTION_BINS, type DexterityMap } from './reachMap';

export type UpAxis = '+X' | '+Y' | '+Z';
export type ViewKey = 'top' | 'front' | 'side';
type Axis = 0 | 1 | 2;

export const AXIS_NAMES = ['X', 'Y', 'Z'] as const;

/**
 * One orthographic view. `h` points right and `v` points up on the page;
 * h × v points at the viewer, so no view is mirrored.
 */
export interface ViewSpec {
  key: ViewKey;
  title: string;
  h: Axis;
  v: Axis;
  /** Axis the view looks along (towards -depth for top, etc.). */
  depth: Axis;
}

/**
 * Plan (top), front and right-side views for the robot's up axis. For a
 * Z-up robot: top shows X→ Y↑, front is seen from −Y (X→ Z↑), side is seen
 * from +X (Y→ Z↑) — the same directions as the viewport's camera presets.
 */
export function reportViews(up: UpAxis): ViewSpec[] {
  const u = ({ '+X': 0, '+Y': 1, '+Z': 2 } as const)[up];
  const a = ((u + 1) % 3) as Axis;
  const b = ((u + 2) % 3) as Axis;
  return [
    { key: 'front', title: 'Front', h: a, v: u, depth: b },
    { key: 'side', title: 'Side', h: b, v: u, depth: a },
    { key: 'top', title: 'Top', h: a, v: b, depth: u }
  ];
}

export interface Projection {
  view: ViewSpec;
  /** Cells across (h) and up (v). */
  columns: number;
  rows: number;
  cellSize: number;
  /** Coordinates of the grid's lower-left corner, in metres. */
  hMin: number;
  vMin: number;
  /**
   * Highest dexterity (0..1) of any voxel behind each cell, row-major from
   * the bottom row; 0 where nothing was reached.
   */
  values: Float32Array;
}

function boundsMin(map: DexterityMap, axis: Axis): number {
  return axis === 0 ? map.bounds.minX : axis === 1 ? map.bounds.minY : map.bounds.minZ;
}

function boundsMax(map: DexterityMap, axis: Axis): number {
  return axis === 0 ? map.bounds.maxX : axis === 1 ? map.bounds.maxY : map.bounds.maxZ;
}

/** Number of voxel cells the map spans along an axis. */
function cellsAlong(map: DexterityMap, axis: Axis): number {
  return Math.floor((boundsMax(map, axis) - boundsMin(map, axis)) / map.voxelSize) + 1;
}

/**
 * Collapse the map onto a view, keeping the best voxel along each line of
 * sight. This answers "is there somewhere along this line where the tool
 * has this much freedom", which is what a plan or elevation is read for.
 */
export function projectMap(map: DexterityMap, view: ViewSpec): Projection {
  const size = map.voxelSize;
  const columns = map.count > 0 ? cellsAlong(map, view.h) : 0;
  const rows = map.count > 0 ? cellsAlong(map, view.v) : 0;
  const hMin = boundsMin(map, view.h);
  const vMin = boundsMin(map, view.v);
  const values = new Float32Array(columns * rows);
  for (let i = 0; i < map.count; i += 1) {
    const column = clampIndex(Math.round((map.centers[i * 3 + view.h] - hMin) / size - 0.5), columns);
    const row = clampIndex(Math.round((map.centers[i * 3 + view.v] - vMin) / size - 0.5), rows);
    const cell = row * columns + column;
    if (map.dexterity[i] > values[cell]) {
      values[cell] = map.dexterity[i];
    }
  }
  return { view, columns, rows, cellSize: size, hMin, vMin, values };
}

function clampIndex(index: number, count: number): number {
  return index < 0 ? 0 : index >= count ? count - 1 : index;
}

export interface ReachSummary {
  voxelCount: number;
  voxelSize: number;
  /** Reached volume, in m³ (voxel count × voxel volume). */
  volume: number;
  /** Farthest reach from the base's vertical axis, to the voxel's outer edge. */
  horizontalReach: number;
  /** Farthest reach from the base origin, to the voxel's outer edge. */
  sphericalReach: number;
  /** Lowest and highest sampled tip height along the up axis. */
  heightRange: [number, number];
  /** Best number of approach directions reached by any voxel. */
  bestDirections: number;
  /** Where the best voxels are (their centroid), in base coordinates. */
  bestCentroid: [number, number, number];
  /**
   * Share of the reached volume in each band of approach directions:
   * 1–6, 7–12, 13–18 and 19–24 of 24.
   */
  bands: Array<{ from: number; to: number; share: number }>;
}

export function summarizeMap(map: DexterityMap, up: UpAxis): ReachSummary {
  const u = ({ '+X': 0, '+Y': 1, '+Z': 2 } as const)[up];
  const half = map.voxelSize / 2;
  // Outer corner of a voxel is at most √3·half beyond its centre.
  const corner = Math.sqrt(3) * half;
  const edge = Math.SQRT2 * half;
  let horizontalReach = 0;
  let sphericalReach = 0;
  const bandCounts = [0, 0, 0, 0];
  const bestDirections = map.count > 0 ? Math.round(map.dexterity[0] * DIRECTION_BINS) : 0;
  const centroid: [number, number, number] = [0, 0, 0];
  let bestCount = 0;
  for (let i = 0; i < map.count; i += 1) {
    const x = map.centers[i * 3];
    const y = map.centers[i * 3 + 1];
    const z = map.centers[i * 3 + 2];
    const along = u === 0 ? x : u === 1 ? y : z;
    const radial = Math.sqrt(Math.max(0, x * x + y * y + z * z - along * along));
    horizontalReach = Math.max(horizontalReach, radial + edge);
    sphericalReach = Math.max(sphericalReach, Math.hypot(x, y, z) + corner);
    const directions = Math.round(map.dexterity[i] * DIRECTION_BINS);
    bandCounts[Math.min(3, Math.floor((directions - 1) / 6))] += 1;
    if (directions === bestDirections) {
      centroid[0] += x;
      centroid[1] += y;
      centroid[2] += z;
      bestCount += 1;
    }
  }
  if (bestCount > 0) {
    centroid[0] /= bestCount;
    centroid[1] /= bestCount;
    centroid[2] /= bestCount;
  }
  const axis = u as Axis;
  return {
    voxelCount: map.count,
    voxelSize: map.voxelSize,
    volume: map.count * map.voxelSize ** 3,
    horizontalReach: map.count > 0 ? horizontalReach : 0,
    sphericalReach: map.count > 0 ? sphericalReach : 0,
    // The map's bounds are the extreme sampled positions themselves.
    heightRange: map.count > 0 ? [boundsMin(map, axis), boundsMax(map, axis)] : [0, 0],
    bestDirections,
    bestCentroid: centroid,
    bands: bandCounts.map((count, i) => ({
      from: i * 6 + 1,
      to: (i + 1) * 6,
      share: map.count > 0 ? count / map.count : 0
    }))
  };
}

/** One row per voxel: centre in metres (robot base frame) and its dexterity. */
export function buildReachCsv(map: DexterityMap): string {
  const lines = ['x_m,y_m,z_m,directions_reached,directions_total,dexterity'];
  for (let i = 0; i < map.count; i += 1) {
    lines.push([
      map.centers[i * 3].toFixed(4),
      map.centers[i * 3 + 1].toFixed(4),
      map.centers[i * 3 + 2].toFixed(4),
      Math.round(map.dexterity[i] * DIRECTION_BINS),
      DIRECTION_BINS,
      map.dexterity[i].toFixed(4)
    ].join(','));
  }
  return `${lines.join('\n')}\n`;
}

/** A tick spacing of 1, 2 or 5 × 10ⁿ giving roughly `target` ticks over `span`. */
export function niceStep(span: number, target = 6): number {
  if (!(span > 0)) {
    return 1;
  }
  const raw = span / target;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  return (unit < 1.5 ? 1 : unit < 3.5 ? 2 : unit < 7.5 ? 5 : 10) * power;
}

export interface ViewRect {
  hMin: number;
  hMax: number;
  vMin: number;
  vMax: number;
}

export interface Bounds3 {
  min: [number, number, number];
  max: [number, number, number];
}

/**
 * World rectangle each view shows: the reached area and the robot, with a
 * little margin. Shared by the silhouette renders and the drawing so they
 * line up exactly.
 */
export function planViewRects(map: DexterityMap, robot: Bounds3 | undefined, views: ViewSpec[]): Record<ViewKey, ViewRect> {
  // Per-axis ranges, so aligned views (front/side share the vertical axis,
  // front/top the horizontal one) use identical extents.
  const ranges = ([0, 1, 2] as Axis[]).map(axis => {
    let min = boundsMin(map, axis);
    let max = min + cellsAlong(map, axis) * map.voxelSize;
    if (robot) {
      min = Math.min(min, robot.min[axis]);
      max = Math.max(max, robot.max[axis]);
    }
    return [min, max] as [number, number];
  });
  const pad = 0.04 * Math.max(...ranges.map(([min, max]) => max - min), 1e-3);
  const result = {} as Record<ViewKey, ViewRect>;
  for (const view of views) {
    result[view.key] = {
      hMin: ranges[view.h][0] - pad,
      hMax: ranges[view.h][1] + pad,
      vMin: ranges[view.v][0] - pad,
      vMax: ranges[view.v][1] + pad
    };
  }
  return result;
}

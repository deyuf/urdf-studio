import { strict as assert } from 'node:assert';
import test from 'node:test';
import { jsPDF } from 'jspdf';
import { DIRECTION_BINS, type DexterityMap } from '../../src/renderer/logic/reachMap';
import {
  buildReachCsv,
  niceStep,
  planViewRects,
  projectMap,
  reportViews,
  summarizeMap
} from '../../src/renderer/logic/reachReport';
import { buildReachabilityPdf } from '../../src/renderer/features/reachReport';

/** Hand-made map on a 0.1 m grid: voxels given as [ix, iy, iz, directions]. */
function makeMap(cells: Array<[number, number, number, number]>): DexterityMap {
  const size = 0.1;
  const sorted = [...cells].sort((a, b) => b[3] - a[3]);
  const centers = new Float32Array(sorted.length * 3);
  const dexterity = new Float32Array(sorted.length);
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  sorted.forEach(([ix, iy, iz, d], i) => {
    centers.set([(ix + 0.5) * size, (iy + 0.5) * size, (iz + 0.5) * size], i * 3);
    dexterity[i] = d / DIRECTION_BINS;
    minX = Math.min(minX, ix * size); maxX = Math.max(maxX, (ix + 0.999) * size);
    minY = Math.min(minY, iy * size); maxY = Math.max(maxY, (iy + 0.999) * size);
    minZ = Math.min(minZ, iz * size); maxZ = Math.max(maxZ, (iz + 0.999) * size);
  });
  return {
    voxelSize: size, centers, dexterity, count: sorted.length,
    bounds: { minX, maxX, minY, maxY, minZ, maxZ },
    extent: Math.max(maxX - minX, maxY - minY, maxZ - minZ)
  };
}

test('reportViews: no mirrored views for any up axis, matching the camera presets for Z-up', () => {
  for (const up of ['+X', '+Y', '+Z'] as const) {
    for (const view of reportViews(up)) {
      assert.equal(new Set([view.h, view.v, view.depth]).size, 3, `${up} ${view.key}`);
    }
  }
  const z = Object.fromEntries(reportViews('+Z').map(v => [v.key, [v.h, v.v]]));
  assert.deepEqual(z, { front: [0, 2], side: [1, 2], top: [0, 1] });
});

test('projectMap keeps the best voxel along each line of sight', () => {
  // Two voxels stacked along Y (the front view's depth), different dexterity.
  const map = makeMap([[0, 0, 0, 6], [0, 3, 0, 18], [2, 0, 1, 1]]);
  const front = projectMap(map, reportViews('+Z').find(v => v.key === 'front')!);
  assert.equal(front.columns, 3);
  assert.equal(front.rows, 2);
  assert.ok(Math.abs(front.values[0] - 18 / 24) < 1e-6, 'max of the stacked pair');
  assert.ok(Math.abs(front.values[1 * 3 + 2] - 1 / 24) < 1e-6);
  assert.equal(front.values[1], 0, 'empty cell');
});

test('summarizeMap: volume, reach, height range and dexterity bands', () => {
  const map = makeMap([[0, 0, 0, 24], [1, 0, 0, 20], [-3, 0, 2, 3], [0, 0, -1, 10]]);
  const summary = summarizeMap(map, '+Z');
  assert.ok(Math.abs(summary.volume - 4 * 0.001) < 1e-9);
  assert.equal(summary.bestDirections, 24);
  // Farthest voxel from the Z axis is centred at (-0.25, 0.05); reach runs to its outer edge.
  assert.ok(Math.abs(summary.horizontalReach - (Math.hypot(0.25, 0.05) + Math.SQRT2 * 0.05)) < 1e-6);
  assert.ok(Math.abs(summary.heightRange[0] - -0.1) < 1e-6);
  assert.ok(Math.abs(summary.heightRange[1] - 0.2999) < 1e-6);
  assert.deepEqual(summary.bands.map(b => b.share), [0.25, 0.25, 0, 0.5]);
});

test('buildReachCsv writes one row per voxel with a header', () => {
  const csv = buildReachCsv(makeMap([[0, 0, 0, 24], [1, 0, 0, 12]]));
  const lines = csv.trim().split('\n');
  assert.equal(lines[0], 'x_m,y_m,z_m,directions_reached,directions_total,dexterity');
  assert.equal(lines.length, 3);
  assert.equal(lines[2], '0.1500,0.0500,0.0500,12,24,0.5000');
});

test('niceStep picks 1, 2 or 5 × 10ⁿ', () => {
  assert.equal(niceStep(2, 6), 0.2);
  assert.equal(niceStep(3, 6), 0.5);
  assert.equal(niceStep(1, 6), 0.2);
  assert.equal(niceStep(10, 5), 2);
  assert.equal(niceStep(0), 1);
});

test('planViewRects gives aligned views identical extents on shared axes', () => {
  const map = makeMap([[0, 0, 0, 24], [5, -2, 8, 3]]);
  const rects = planViewRects(map, { min: [-0.2, -0.1, -0.05], max: [0.1, 0.1, 1.2] }, reportViews('+Z'));
  assert.deepEqual([rects.front.vMin, rects.front.vMax], [rects.side.vMin, rects.side.vMax]);
  assert.deepEqual([rects.front.hMin, rects.front.hMax], [rects.top.hMin, rects.top.hMax]);
  assert.deepEqual([rects.side.hMin, rects.side.hMax], [rects.top.vMin, rects.top.vMax]);
  assert.ok(rects.front.vMax > 1.2, 'robot taller than the map is included');
});

test('buildReachabilityPdf writes a two-sheet report with the key figures', () => {
  const map = makeMap([[0, 0, 0, 24], [1, 0, 0, 20], [-3, 0, 2, 3], [0, 0, -1, 10]]);
  const views = reportViews('+Z');
  const pdf = new jsPDF({ unit: 'pt', format: 'a4', orientation: 'landscape' });
  buildReachabilityPdf(pdf, {
    robotName: 'test_arm',
    sourcePath: '/ws/src/arm/urdf/arm.urdf',
    tipLinkName: 'tool0',
    sampleCount: 1_000_000,
    elapsedMs: 950,
    up: '+Z',
    map,
    rects: planViewRects(map, undefined, views),
    generated: new Date('2026-11-12T10:00:00Z')
  });
  assert.equal(pdf.getNumberOfPages(), 2);
  const text = pdf.output();
  for (const expected of ['Reachability report', 'tool0', '1,000,000', 'FRONT VIEW', 'SIDE VIEW', 'TOP VIEW', 'test_arm', '2026-11-12', '24 of 24']) {
    assert.ok(text.includes(expected), `missing "${expected}"`);
  }
});

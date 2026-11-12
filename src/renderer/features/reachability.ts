// Reachability / dexterity map for a chosen tip link.
//
// Sampling runs forward kinematics on a pre-extracted chain (see
// logic/reachMap.ts), so it never moves the robot and is fast enough for
// hundreds of thousands of samples. The result is drawn as one point per
// voxel, coloured by how many approach directions reached it.

import * as THREE from 'three';
import type { URDFRobot } from 'urdf-loader/src/URDFClasses';
import type { RobotMetadata } from '../../core/types';
import {
  buildDexterityMap,
  dexterityColor,
  DIRECTION_BINS,
  extractChain,
  sampleChainRange,
  type ChainSamples,
  type DexterityMap
} from '../logic/reachMap';

export interface ReachabilityDeps {
  scene: THREE.Scene;
  /** Re-fit the camera so the cloud and the robot are both in view. */
  fitCameraToBox(box: THREE.Box3): void;
  /** Signal to the renderer that the scene is dirty (re-render needed). */
  requestRedraw(): void;
  /** Optional callback for the test probe. */
  onStateChange?: () => void;
}

export interface ReachabilityOptions {
  robot: URDFRobot;
  metadata: RobotMetadata;
  tipLinkName: string;
  sampleCount: number;
  /** Deterministic source for tests; Math.random by default. */
  random?: () => number;
}

export interface ReachabilityResult {
  sampleCount: number;
  voxelCount: number;
  voxelSize: number;
  /** Highest share of approach directions reached by any voxel (0..1). */
  maxDexterity: number;
  elapsedMs: number;
  bounds: DexterityMap['bounds'];
}

/** Time budget per chunk before yielding to the browser. */
const FRAME_BUDGET_MS = 14;

export class Reachability {
  private points: THREE.Points | undefined;
  private map: DexterityMap | undefined;
  private lastRun: { tipLinkName: string; sampleCount: number; elapsedMs: number } | undefined;
  private run = 0;

  constructor(private readonly deps: ReachabilityDeps) {}

  /** Number of voxels currently drawn (0 when disposed). */
  pointCount(): number {
    return this.points?.geometry.drawRange.count === Infinity
      ? this.map?.count ?? 0
      : this.points?.geometry.drawRange.count ?? 0;
  }

  /** Has the cloud been rendered into the scene? */
  isVisible(): boolean {
    return this.points !== undefined;
  }

  /** The current map and how it was made, for reports; undefined when cleared. */
  current(): { map: DexterityMap; tipLinkName: string; sampleCount: number; elapsedMs: number } | undefined {
    return this.map && this.lastRun ? { map: this.map, ...this.lastRun } : undefined;
  }

  /** Show or hide the cloud without discarding it (used for report renders). */
  setCloudVisible(visible: boolean): void {
    if (this.points) {
      this.points.visible = visible;
    }
  }

  /** Highest dexterity in the current map, or 0. */
  maxDexterity(): number {
    return this.map && this.map.count > 0 ? this.map.dexterity[0] : 0;
  }

  /** Wipe the cloud from the scene, cancel a running sweep and clear the status. */
  dispose(): void {
    this.run += 1;
    this.removePoints();
    this.setStatus('');
    this.setLegend(undefined);
    this.deps.onStateChange?.();
  }

  /**
   * Show only voxels whose dexterity is at least `fraction` of the best
   * voxel's. Voxels are stored best first, so this only changes the draw
   * range — no rebuild.
   */
  setMinimumShare(fraction: number): void {
    if (!this.points || !this.map) {
      return;
    }
    const threshold = this.maxDexterity() * Math.max(0, Math.min(1, fraction)) - 1e-6;
    let visible = 0;
    while (visible < this.map.count && this.map.dexterity[visible] >= threshold) {
      visible += 1;
    }
    this.points.geometry.setDrawRange(0, Math.max(1, visible));
    this.deps.requestRedraw();
    this.deps.onStateChange?.();
  }

  /**
   * Run the sweep. Works in time-boxed chunks and reports progress in
   * #reach-status, so even very large sample counts keep the UI responsive.
   */
  async sample(options: ReachabilityOptions): Promise<ReachabilityResult | undefined> {
    const { robot, metadata, tipLinkName } = options;
    const sampleCount = Math.max(1, Math.floor(options.sampleCount));
    if (!robot.links?.[tipLinkName]) {
      this.setStatus('Pick a valid tip link first.');
      return undefined;
    }
    if (metadata.movableJointNames.length === 0) {
      this.setStatus('No movable joints to sample.');
      return undefined;
    }
    const chain = extractChain(robot, metadata, tipLinkName);
    if (!chain) {
      this.setStatus(`"${tipLinkName}" is not attached to the robot.`);
      return undefined;
    }

    this.dispose();
    const run = this.run;
    const started = performance.now();
    const samples: ChainSamples = {
      count: sampleCount,
      positions: new Float32Array(sampleCount * 3),
      bins: new Uint8Array(sampleCount)
    };
    // Calibrate the chunk size on the first chunk, then keep each chunk
    // inside one frame's budget.
    let done = 0;
    let chunk = 2000;
    this.setStatus(`Sampling ${sampleCount.toLocaleString('en-US')}…`);
    while (done < sampleCount) {
      const end = Math.min(sampleCount, done + chunk);
      const chunkStart = performance.now();
      sampleChainRange(chain, samples, done, end, options.random);
      const spent = performance.now() - chunkStart;
      chunk = Math.max(500, Math.round(((end - done) * FRAME_BUDGET_MS) / Math.max(spent, 0.5)));
      done = end;
      if (done < sampleCount) {
        this.setStatus(`Sampling… ${Math.round((done / sampleCount) * 100)}%`);
        await new Promise<void>(resolve => setTimeout(resolve, 0));
        if (run !== this.run) {
          return undefined; // cleared or restarted meanwhile
        }
      }
    }

    const map = buildDexterityMap(samples);
    const elapsedMs = performance.now() - started;
    this.map = map;
    this.points = this.buildPoints(map);
    // Map coordinates are in the robot's base frame; place the cloud with it.
    this.points.matrixAutoUpdate = false;
    this.points.matrix.copy(chain.placement);
    this.points.updateMatrixWorld(true);
    this.deps.scene.add(this.points);
    this.lastRun = { tipLinkName, sampleCount, elapsedMs };

    const maxDexterity = this.maxDexterity();
    if (map.extent < 0.005) {
      // A tip that no joint moves collapses to a single voxel hidden inside
      // the robot — say so instead of appearing to draw nothing.
      this.setStatus(`"${tipLinkName}" does not move with any joint, so every sample lands on the same spot. Choose a link further along the arm.`);
    } else {
      const { minX, maxX, minY, maxY, minZ, maxZ } = map.bounds;
      this.setStatus(
        `${sampleCount.toLocaleString('en-US')} samples in ${formatSeconds(elapsedMs)} · ` +
        `${map.count.toLocaleString('en-US')} voxels of ${formatLength(map.voxelSize)} · ` +
        `X[${minX.toFixed(2)}, ${maxX.toFixed(2)}] Y[${minY.toFixed(2)}, ${maxY.toFixed(2)}] Z[${minZ.toFixed(2)}, ${maxZ.toFixed(2)}] m`
      );
    }
    this.setLegend(maxDexterity);

    const box = new THREE.Box3().setFromObject(robot as unknown as THREE.Object3D);
    box.union(new THREE.Box3(
      new THREE.Vector3(map.bounds.minX, map.bounds.minY, map.bounds.minZ),
      new THREE.Vector3(map.bounds.maxX, map.bounds.maxY, map.bounds.maxZ)
    ).applyMatrix4(chain.placement));
    this.deps.fitCameraToBox(box);
    this.deps.requestRedraw();
    this.deps.onStateChange?.();
    return {
      sampleCount,
      voxelCount: map.count,
      voxelSize: map.voxelSize,
      maxDexterity,
      elapsedMs,
      bounds: map.bounds
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private buildPoints(map: DexterityMap): THREE.Points {
    const colors = new Float32Array(map.count * 3);
    const max = Math.max(map.count > 0 ? map.dexterity[0] : 0, 1 / DIRECTION_BINS);
    const min = 1 / DIRECTION_BINS;
    const rgb: [number, number, number] = [0, 0, 0];
    for (let i = 0; i < map.count; i += 1) {
      // Scale between one direction and the best voxel, so the full colour
      // range is used whatever the robot's overall dexterity.
      const t = max > min ? (map.dexterity[i] - min) / (max - min) : 1;
      dexterityColor(t, rgb);
      colors[i * 3] = rgb[0];
      colors[i * 3 + 1] = rgb[1];
      colors[i * 3 + 2] = rgb[2];
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(map.centers, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeBoundingSphere();
    // Points smaller than the voxel leave gaps, so dense cores stay visible
    // through the low-dexterity shell around them.
    const material = new THREE.PointsMaterial({
      size: Math.max(map.voxelSize * 0.55, 0.002),
      sizeAttenuation: true,
      vertexColors: true,
      map: discTexture(),
      alphaTest: 0.5
    });
    const points = new THREE.Points(geometry, material);
    points.name = 'reachability';
    points.renderOrder = 1;
    return points;
  }

  private removePoints(): void {
    if (!this.points) {
      return;
    }
    this.deps.scene.remove(this.points);
    this.points.geometry.dispose();
    const material = this.points.material as THREE.PointsMaterial;
    material.map?.dispose();
    material.dispose();
    this.points = undefined;
    this.map = undefined;
    this.lastRun = undefined;
    this.deps.requestRedraw();
  }

  private setStatus(text: string): void {
    const status = document.getElementById('reach-status');
    if (status) {
      status.textContent = text;
    }
  }

  private setLegend(maxDexterity: number | undefined): void {
    const legend = document.getElementById('reach-legend');
    if (!legend) {
      return;
    }
    legend.hidden = maxDexterity === undefined;
    const high = document.getElementById('reach-legend-max');
    if (high && maxDexterity !== undefined) {
      high.textContent = `${Math.round(maxDexterity * DIRECTION_BINS)} of ${DIRECTION_BINS}`;
    }
  }
}

/** Soft-edged round sprite so points read as dots, not squares. */
function discTexture(): THREE.DataTexture {
  const size = 32;
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x + 0.5) / size - 0.5;
      const dy = (y + 0.5) / size - 0.5;
      const inside = Math.hypot(dx, dy) <= 0.5;
      const offset = (y * size + x) * 4;
      data[offset] = 255;
      data[offset + 1] = 255;
      data[offset + 2] = 255;
      data[offset + 3] = inside ? 255 : 0;
    }
  }
  const texture = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  texture.magFilter = THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

function formatSeconds(ms: number): string {
  return ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
}

function formatLength(metres: number): string {
  return metres < 0.1 ? `${(metres * 100).toFixed(1)} cm` : `${metres.toFixed(2)} m`;
}

// Reachability cloud: Monte-Carlo workspace samples for a chosen tip link.
//
// Extracted from renderer/main.ts so the sampling loop + visualisation
// lifecycle (geometry / material / scene attachment / disposal) are not
// tangled with the rest of the renderer's state.
//
// The loop itself still has to drive THREE's matrix updates and read the
// link's world position, so we can't make it 100% pure — but the entry
// points are narrow enough that a unit test can exercise the dispose +
// snapshot paths with a fake scene, and the renderer-side integration
// stays small.

import * as THREE from 'three';
import type { URDFRobot } from 'urdf-loader/src/URDFClasses';
import type { JointInfo, RobotMetadata } from '../../core/types';
import { jointRange } from '../logic/displayGroups';

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
  /** Restored to the robot after sampling. */
  poseBeforeSampling: Record<string, number>;
  /** How the caller drives a single pose into the robot (mimic-aware). */
  applyPose(pose: Record<string, number>): void;
  /** Propagate mimic joints after a master joint is set by the sampler. */
  propagateMimics(robot: URDFRobot, metadata: RobotMetadata): void;
}

export interface ReachabilityResult {
  sampleCount: number;
  bounds: { minX: number; maxX: number; minY: number; maxY: number; minZ: number; maxZ: number };
}

export class Reachability {
  private points: THREE.Points | undefined;

  constructor(private readonly deps: ReachabilityDeps) {}

  /** Number of vertices currently in the visualised cloud (0 when disposed). */
  pointCount(): number {
    return this.points?.geometry.getAttribute('position')?.count ?? 0;
  }

  /** Has the cloud been rendered into the scene at least once? */
  isVisible(): boolean {
    return this.points !== undefined;
  }

  /** Wipe the cloud from the scene and clear the status line. */
  dispose(): void {
    if (this.points) {
      this.deps.scene.remove(this.points);
      this.points.geometry.dispose();
      (this.points.material as THREE.Material).dispose();
      this.points = undefined;
      this.deps.requestRedraw();
    }
    const status = document.getElementById('reach-status');
    if (status) {
      status.textContent = '';
    }
    this.deps.onStateChange?.();
  }

  /**
   * Run the Monte-Carlo sweep. Streams the status text into #reach-status
   * (no-op if absent) and yields to the event loop every 200 samples so
   * the UI repaints during long sweeps.
   */
  async sample(options: ReachabilityOptions): Promise<ReachabilityResult | undefined> {
    const { robot, metadata, tipLinkName, sampleCount } = options;
    const tipObject = robot.links?.[tipLinkName];
    if (!tipObject) {
      this.setStatus('Pick a valid tip link first.');
      return undefined;
    }
    const movable = metadata.movableJointNames;
    if (movable.length === 0) {
      this.setStatus('No movable joints to sample.');
      return undefined;
    }

    this.setStatus(`Sampling ${sampleCount}…`);
    this.dispose();

    const ranges = movable.map(name => jointRange(metadata.joints[name] as JointInfo | undefined));
    const previousIgnoreLimits = this.bypassJointLimits(robot, metadata);

    const positions = new Float32Array(sampleCount * 3);
    const colors = new Float32Array(sampleCount * 3);
    const tmp = new THREE.Vector3();
    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    for (let i = 0; i < sampleCount; i += 1) {
      for (let j = 0; j < movable.length; j += 1) {
        const [min, max] = ranges[j];
        const value = min + Math.random() * (max - min);
        robot.setJointValue(movable[j], value);
      }
      options.propagateMimics(robot, metadata);
      robot.updateMatrixWorld(true);
      tipObject.getWorldPosition(tmp);
      positions[i * 3] = tmp.x;
      positions[i * 3 + 1] = tmp.y;
      positions[i * 3 + 2] = tmp.z;
      if (tmp.x < minX) minX = tmp.x;
      if (tmp.y < minY) minY = tmp.y;
      if (tmp.z < minZ) minZ = tmp.z;
      if (tmp.x > maxX) maxX = tmp.x;
      if (tmp.y > maxY) maxY = tmp.y;
      if (tmp.z > maxZ) maxZ = tmp.z;
      if (i % 200 === 0 && i > 0) {
        // Yield so the page can repaint mid-sweep.
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
    }

    this.restoreJointLimits(robot, previousIgnoreLimits);

    // Colour points by relative height — makes dense regions distinguishable
    // from a uniform sphere.
    const span = Math.max(1e-6, maxZ - minZ);
    for (let i = 0; i < sampleCount; i += 1) {
      const t = (positions[i * 3 + 2] - minZ) / span;
      colors[i * 3] = 0.2 + 0.8 * t;
      colors[i * 3 + 1] = 0.9 - 0.4 * t;
      colors[i * 3 + 2] = 0.4 + 0.5 * (1 - t);
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const reachExtent = Math.max(maxX - minX, maxY - minY, maxZ - minZ, 1e-3);
    const pointSize = Math.max(0.01, reachExtent * 0.015);
    const material = new THREE.PointsMaterial({ size: pointSize, sizeAttenuation: true, vertexColors: true });
    this.points = new THREE.Points(geometry, material);
    this.deps.scene.add(this.points);

    options.applyPose(options.poseBeforeSampling);
    this.setStatus(`${sampleCount} samples · X[${minX.toFixed(2)}, ${maxX.toFixed(2)}] Y[${minY.toFixed(2)}, ${maxY.toFixed(2)}] Z[${minZ.toFixed(2)}, ${maxZ.toFixed(2)}].`);

    // Refit camera so the cloud is in view alongside the robot.
    const robotBox = new THREE.Box3().setFromObject(robot);
    const cloudBox = new THREE.Box3().setFromObject(this.points);
    this.deps.fitCameraToBox(robotBox.union(cloudBox));

    this.deps.requestRedraw();
    this.deps.onStateChange?.();
    return {
      sampleCount,
      bounds: { minX, maxX, minY, maxY, minZ, maxZ }
    };
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * URDFLoader clamps setJointValue to its own parsed limits — which can
   * default to [0, 0] when <limit> is omitted. Bypass clamping during
   * sampling so the cloud reflects our metadata's joint ranges, and
   * return the previous flag values for restoration.
   */
  private bypassJointLimits(robot: URDFRobot, metadata: RobotMetadata): Record<string, boolean> {
    const previous: Record<string, boolean> = {};
    for (const name of metadata.movableJointNames) {
      const joint = robot.joints?.[name];
      if (joint) {
        previous[name] = !!joint.ignoreLimits;
        joint.ignoreLimits = true;
      }
    }
    for (const [name, info] of Object.entries(metadata.joints)) {
      if (info.mimic && robot.joints?.[name]) {
        previous[name] = !!robot.joints[name].ignoreLimits;
        robot.joints[name].ignoreLimits = true;
      }
    }
    return previous;
  }

  private restoreJointLimits(robot: URDFRobot, previous: Record<string, boolean>): void {
    for (const [name, value] of Object.entries(previous)) {
      if (robot.joints?.[name]) {
        robot.joints[name].ignoreLimits = value;
      }
    }
  }

  private setStatus(text: string): void {
    const status = document.getElementById('reach-status');
    if (status) {
      status.textContent = text;
    }
  }
}

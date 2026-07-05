// Inertia ellipsoids + per-link CoM markers + aggregate CoM marker.
//
// Extracted from renderer/main.ts so the geometric construction, scene
// attachment and disposal lifecycle are encapsulated. The actual
// eigenvalue-to-semiaxes math stays in src/core/inertia.ts; this module
// only deals with THREE objects and visibility toggling.

import * as THREE from 'three';
import type { URDFRobot } from 'urdf-loader/src/URDFClasses';
import { inertiaEllipsoid } from '../../core/inertia';
import type { RobotMetadata } from '../../core/types';

export interface InertiaDeps {
  scene: THREE.Scene;
  /** Bounds-relative scale source for marker sizing. */
  getBoundsRadius(): number;
  /** Signal to the renderer that the scene is dirty. */
  requestRedraw(): void;
  /** Optional test-state probe. */
  onStateChange?: () => void;
}

/**
 * Owns the inertia visualisation (per-link ellipsoid + CoM markers and a
 * combined CoM sphere on the scene root). Build the helpers once after a
 * robot is loaded, toggle visibility on user request, and recompute the
 * aggregate CoM after a pose change.
 */
export class InertiaVisualisation {
  private helpers = new Map<string, THREE.Group>();
  private totalMarker: THREE.Mesh | undefined;
  private visible = false;

  constructor(private readonly deps: InertiaDeps) {}

  isVisible(): boolean {
    return this.visible;
  }

  /** Test/diagnostic probe — how many per-link helpers exist. */
  helperCount(): number {
    return this.helpers.size;
  }

  /** True iff a non-trivial aggregate-CoM marker is in the scene. */
  hasTotalMarker(): boolean {
    return this.totalMarker !== undefined;
  }

  /** Wipe everything and reset visibility to the renderer's default (off). */
  dispose(): void {
    this.disposeHelpers();
    this.deps.onStateChange?.();
  }

  /** Remove + dispose all per-link helpers and the aggregate marker. */
  private disposeHelpers(): void {
    for (const group of this.helpers.values()) {
      group.parent?.remove(group);
      group.traverse(object => {
        const mesh = object as THREE.Mesh;
        if (!mesh.isMesh) {
          return;
        }
        mesh.geometry?.dispose();
        for (const material of materials(mesh)) {
          material.dispose();
        }
      });
    }
    this.helpers.clear();
    if (this.totalMarker) {
      this.deps.scene.remove(this.totalMarker);
      this.totalMarker.geometry.dispose();
      (this.totalMarker.material as THREE.Material).dispose();
      this.totalMarker = undefined;
    }
  }

  /** Build per-link ellipsoid + CoM markers, plus the aggregate marker. */
  build(robot: URDFRobot, metadata: RobotMetadata): void {
    if (!robot.links) {
      return;
    }
    // Defensive: clear any previously built helpers so a repeated build (e.g.
    // a reload that races with a prior load) cannot orphan ellipsoid groups
    // on links or leave a stale aggregate marker in the scene.
    if (this.helpers.size > 0 || this.totalMarker) {
      this.disposeHelpers();
    }
    for (const link of Object.values(metadata.links)) {
      const inertial = link.inertial;
      if (!inertial || inertial.mass <= 0) {
        continue;
      }
      const linkObject = robot.links[link.name];
      if (!linkObject) {
        continue;
      }
      const group = new THREE.Group();
      group.position.set(inertial.origin[0], inertial.origin[1], inertial.origin[2]);
      // URDF rpy is extrinsic XYZ = intrinsic ZYX, matching urdf-loader's own
      // joint/visual origin handling. The default THREE 'XYZ' order would
      // mis-orient inertial frames with two or more non-zero rpy components.
      group.rotation.set(inertial.rotation[0], inertial.rotation[1], inertial.rotation[2], 'ZYX');

      const { semiAxes, rotation } = inertiaEllipsoid(inertial);
      const ellipsoidGeometry = new THREE.SphereGeometry(1, 24, 16);
      const ellipsoidMaterial = new THREE.MeshStandardMaterial({
        color: 0x9ad7ff,
        transparent: true,
        opacity: 0.35,
        roughness: 0.5,
        metalness: 0,
        depthWrite: false
      });
      const ellipsoidMesh = new THREE.Mesh(ellipsoidGeometry, ellipsoidMaterial);
      // Orient the ellipsoid along the tensor's principal axes (eigenvectors),
      // then scale by the matching semi-axes.
      const principal = new THREE.Matrix4().set(
        rotation[0], rotation[1], rotation[2], 0,
        rotation[3], rotation[4], rotation[5], 0,
        rotation[6], rotation[7], rotation[8], 0,
        0, 0, 0, 1
      );
      ellipsoidMesh.quaternion.setFromRotationMatrix(principal);
      ellipsoidMesh.scale.set(
        Math.max(semiAxes[0], 1e-4),
        Math.max(semiAxes[1], 1e-4),
        Math.max(semiAxes[2], 1e-4)
      );
      group.add(ellipsoidMesh);

      const sphereSize = Math.max(0.005, this.deps.getBoundsRadius() * 0.01);
      const comMarker = new THREE.Mesh(
        new THREE.SphereGeometry(sphereSize, 14, 10),
        new THREE.MeshBasicMaterial({ color: 0xffaa44 })
      );
      group.add(comMarker);

      group.visible = this.visible;
      linkObject.add(group);
      this.helpers.set(link.name, group);
    }

    if (metadata.totalMass > 0) {
      const sphereSize = Math.max(0.01, this.deps.getBoundsRadius() * 0.018);
      this.totalMarker = new THREE.Mesh(
        new THREE.SphereGeometry(sphereSize, 18, 12),
        new THREE.MeshBasicMaterial({ color: 0xff8855 })
      );
      this.totalMarker.visible = this.visible;
      this.deps.scene.add(this.totalMarker);
      this.updateTotalMarker(robot, metadata);
    }
    this.deps.onStateChange?.();
  }

  /** Toggle ellipsoid + CoM marker visibility. */
  setVisible(visible: boolean, robot?: URDFRobot, metadata?: RobotMetadata): void {
    this.visible = visible;
    for (const group of this.helpers.values()) {
      group.visible = visible;
    }
    if (this.totalMarker) {
      this.totalMarker.visible = visible;
    }
    if (visible && robot && metadata) {
      this.updateTotalMarker(robot, metadata);
    }
    this.deps.requestRedraw();
    this.deps.onStateChange?.();
  }

  /** Recompute the aggregate CoM after a pose update. No-op when hidden. */
  refreshTotal(robot: URDFRobot, metadata: RobotMetadata): void {
    if (!this.visible || !this.totalMarker) {
      return;
    }
    this.updateTotalMarker(robot, metadata);
  }

  // -------------------------------------------------------------------------

  private updateTotalMarker(robot: URDFRobot, metadata: RobotMetadata): void {
    if (!this.totalMarker || !robot.links) {
      return;
    }
    const com = new THREE.Vector3();
    let totalMass = 0;
    const linkLocal = new THREE.Vector3();
    for (const link of Object.values(metadata.links)) {
      const inertial = link.inertial;
      const linkObject = robot.links[link.name];
      if (!inertial || inertial.mass <= 0 || !linkObject) {
        continue;
      }
      linkObject.updateWorldMatrix(true, false);
      linkLocal.set(inertial.origin[0], inertial.origin[1], inertial.origin[2]);
      const world = linkLocal.applyMatrix4(linkObject.matrixWorld);
      com.addScaledVector(world, inertial.mass);
      totalMass += inertial.mass;
    }
    if (totalMass > 0) {
      com.multiplyScalar(1 / totalMass);
      this.totalMarker.position.copy(com);
    }
  }
}

function materials(mesh: THREE.Mesh): THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

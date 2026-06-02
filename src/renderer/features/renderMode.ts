// Render-mode visibility: which of a robot's visual vs. collision geometry is
// shown for the current mode.
//
// We traverse by the `isURDFVisual` / `isURDFCollider` flags rather than the
// `robot.visual` / `robot.colliders` maps. urdf-loader only inserts a node
// into those maps when its <visual>/<collision> element carries a `name`
// attribute, which is optional and frequently omitted (e.g. Franka FR3 has
// none). Keying off the maps therefore left unnamed geometry untouched, so
// once collision meshes were loaded they stayed on screen even after switching
// back to Visual. The flags are set on every visual/collider node regardless
// of naming, so the toggle always reaches them.

import type * as THREE from 'three';
import type { Object3D } from 'three';

export type RenderMode = 'visual' | 'collision' | 'both';

const COLLIDER_COLOR = 0x71d0ff;

interface URDFNodeFlags {
  isURDFVisual?: boolean;
  isURDFCollider?: boolean;
}

export interface RenderModeDeps {
  /** Iterate a mesh's material(s); single or array, normalised by the caller. */
  forEachMaterial(mesh: THREE.Mesh, callback: (material: THREE.MeshStandardMaterial) => void): void;
}

/**
 * Show/hide the robot's visual and collision geometry for the given mode and
 * recolour colliders so they read as overlays.
 */
export function applyRenderModeVisibility(robot: Object3D, mode: RenderMode, deps: RenderModeDeps): void {
  const showVisual = mode === 'visual' || mode === 'both';
  const showCollision = mode === 'collision' || mode === 'both';
  robot.traverse((object: Object3D) => {
    const flags = object as URDFNodeFlags;
    if (flags.isURDFVisual) {
      object.visible = showVisual;
    } else if (flags.isURDFCollider) {
      object.visible = showCollision;
      object.traverse((child: Object3D) => {
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh) {
          deps.forEachMaterial(mesh, material => {
            material.transparent = true;
            material.opacity = mode === 'both' ? 0.26 : 0.62;
            material.color.set(COLLIDER_COLOR);
          });
        }
      });
    }
  });
}

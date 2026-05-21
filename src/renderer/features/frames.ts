// Per-link TF axes overlay.
//
// Three modes:
//   - off:       no axes shown
//   - selected:  axes only on the currently selected link
//   - all:       axes on every link
//
// Helpers are created lazily — we don't allocate AxesHelpers for hidden
// links — and scale with the robot's bounding radius so big robots get
// proportionally large axes.

import * as THREE from 'three';
import type { URDFRobot } from 'urdf-loader/src/URDFClasses';

export type FramesMode = 'off' | 'selected' | 'all';

export interface FramesDeps {
  /** Bounds-relative size source for the AxesHelper. */
  getBoundsRadius(): number;
  requestRedraw(): void;
  onStateChange?: () => void;
}

export class FramesOverlay {
  private mode: FramesMode = 'off';
  private helpers = new Map<string, THREE.AxesHelper>();

  constructor(private readonly deps: FramesDeps) {}

  current(): FramesMode { return this.mode; }

  /** Test probe: how many AxesHelpers are currently visible. */
  visibleCount(): number {
    let n = 0;
    for (const h of this.helpers.values()) {
      if (h.visible) n++;
    }
    return n;
  }

  /** Detach + dispose every helper. Call when the robot is replaced. */
  dispose(): void {
    for (const helper of this.helpers.values()) {
      helper.parent?.remove(helper);
      helper.dispose();
    }
    this.helpers.clear();
  }

  /** Set the mode and refresh the scene. Pass undefined to keep the mode. */
  apply(mode: FramesMode | undefined, robot: URDFRobot | undefined, selectedLink: string | undefined): void {
    if (mode !== undefined) {
      this.mode = mode;
    }
    if (!robot?.links) {
      this.deps.onStateChange?.();
      return;
    }
    const visibleLinks = new Set<string>();
    if (this.mode === 'all') {
      for (const linkName of Object.keys(robot.links)) {
        visibleLinks.add(linkName);
      }
    } else if (this.mode === 'selected' && selectedLink) {
      visibleLinks.add(selectedLink);
    }
    const size = Math.max(0.05, this.deps.getBoundsRadius() * 0.06);
    for (const linkName of Object.keys(robot.links)) {
      const linkObject = robot.links[linkName];
      let helper = this.helpers.get(linkName);
      if (visibleLinks.has(linkName)) {
        if (!helper) {
          helper = new THREE.AxesHelper(size);
          this.helpers.set(linkName, helper);
          linkObject.add(helper);
        } else {
          // AxesHelper's nominal size is 0.5 internally; scale the existing
          // helper to match the new bounds-relative size instead of disposing
          // and rebuilding.
          helper.scale.setScalar(size / 0.5);
        }
        helper.visible = true;
      } else if (helper) {
        helper.visible = false;
      }
    }
    this.deps.requestRedraw();
    this.deps.onStateChange?.();
  }
}

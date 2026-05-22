// Measurement tool: pick two points on the robot, draw a line + spheres,
// display Δxyz / distance in the Tools panel.
//
// Pulled out of renderer/main.ts so the geometric state (points / line /
// markers) is encapsulated and the DOM updates flow through a clearly
// scoped interface. The renderer wires up button event listeners, the click
// dispatcher, and calls refresh() after re-rendering the Tools panel; this
// module owns everything else.

import * as THREE from 'three';
import { html, setInnerHtml } from '../html';

export interface MeasurementDeps {
  scene: THREE.Scene;
  /** Raycast the cursor from a canvas click; returns the intersection or undefined. */
  raycastFromEvent(event: MouseEvent): THREE.Intersection | undefined;
  /** Bounds-relative scale source for marker / line sizing. */
  getBoundsRadius(): number;
  /** Signal to the renderer that the scene is dirty (re-render needed). */
  requestRedraw(): void;
  /** Called whenever measurement state changes (used for the test probe). */
  onStateChange?: () => void;
}

export interface MeasurementSnapshot {
  /** True while we're waiting on the next user click to drop a point. */
  mode: boolean;
  pointCount: number;
  /** Euclidean distance between the two anchored points, or null if not yet set. */
  distance: number | null;
}

export class Measurement {
  private points: THREE.Vector3[] = [];
  private line: THREE.Line | undefined;
  private markers: THREE.Mesh[] = [];
  private modeActive = false;

  constructor(private readonly deps: MeasurementDeps) {}

  /** True while we're in "click to place a point" mode. */
  isActive(): boolean {
    return this.modeActive;
  }

  /** Read-only snapshot for tests / UI publication. */
  snapshot(): MeasurementSnapshot {
    return {
      mode: this.modeActive,
      pointCount: this.points.length,
      distance: this.points.length === 2 ? this.points[0].distanceTo(this.points[1]) : null
    };
  }

  /** Toggle measurement input mode. Starting a new measurement clears the
   *  prior markers; stopping mid-way keeps them on screen until Clear. */
  toggle(): void {
    if (this.modeActive) {
      this.modeActive = false;
    } else {
      // Starting fresh — wipe the previous measurement.
      this.clearGeometry();
      this.points.length = 0;
      this.modeActive = true;
    }
    this.refresh();
  }

  /**
   * Try to consume a canvas click as a measurement-point drop.
   * Returns true if the click was consumed (mode active), false otherwise.
   * Callers should fall through to selection on a `false` return.
   */
  handleClick(event: MouseEvent): boolean {
    if (!this.modeActive) {
      return false;
    }
    const hit = this.deps.raycastFromEvent(event);
    if (!hit) {
      this.setStatus('Click on the robot geometry.');
      return true;
    }
    if (this.points.length >= 2) {
      // Reset for a new pair if we somehow accumulated extras.
      this.clearGeometry();
      this.points.length = 0;
      this.modeActive = true;
    }
    const point = hit.point.clone();
    this.points.push(point);
    this.addMarker(point);
    if (this.points.length === 2) {
      this.buildLine();
      this.modeActive = false;
    }
    this.refresh();
    this.deps.requestRedraw();
    return true;
  }

  /** Wipe all measurement geometry and reset to idle. */
  clear(): void {
    this.clearGeometry();
    this.points.length = 0;
    this.modeActive = false;
    this.refresh();
    this.deps.requestRedraw();
  }

  /** Re-render the measurement section of the Tools panel + the test probe.
   *  Safe to call when the panel is detached (queries return null). */
  refresh(): void {
    this.deps.onStateChange?.();
    this.updateToggleButton();
    this.updateReadout();
    this.updateStatus();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private clearGeometry(): void {
    for (const marker of this.markers) {
      this.deps.scene.remove(marker);
      marker.geometry.dispose();
      (marker.material as THREE.Material).dispose();
    }
    this.markers.length = 0;
    if (this.line) {
      this.deps.scene.remove(this.line);
      this.line.geometry.dispose();
      (this.line.material as THREE.Material).dispose();
      this.line = undefined;
    }
  }

  private addMarker(point: THREE.Vector3): void {
    const size = Math.max(0.006, this.deps.getBoundsRadius() * 0.012);
    const marker = new THREE.Mesh(
      new THREE.SphereGeometry(size, 14, 10),
      new THREE.MeshBasicMaterial({ color: 0xffd866, depthTest: false })
    );
    marker.renderOrder = 999;
    marker.position.copy(point);
    this.deps.scene.add(marker);
    this.markers.push(marker);
  }

  private buildLine(): void {
    if (this.points.length !== 2) {
      return;
    }
    const geometry = new THREE.BufferGeometry().setFromPoints(this.points);
    const material = new THREE.LineBasicMaterial({ color: 0xffd866, depthTest: false });
    this.line = new THREE.Line(geometry, material);
    this.line.renderOrder = 998;
    this.deps.scene.add(this.line);
  }

  private updateToggleButton(): void {
    const toggle = document.getElementById('measure-toggle');
    if (!toggle) {
      return;
    }
    toggle.textContent = this.modeActive
      ? (this.points.length === 0 ? 'Pick point 1…' : 'Pick point 2…')
      : 'Start measuring';
    toggle.classList.toggle('primary', !this.modeActive);
    toggle.classList.toggle('active', this.modeActive);
  }

  private updateReadout(): void {
    const readout = document.getElementById('measure-readout');
    if (!readout) {
      return;
    }
    if (this.points.length !== 2) {
      readout.replaceChildren();
      return;
    }
    const a = this.points[0];
    const b = this.points[1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const dz = b.z - a.z;
    const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
    setInnerHtml(readout, html`
      <div><b>Distance</b> ${dist.toFixed(4)} m</div>
      <div><b>Δx</b> ${dx.toFixed(4)} <b>Δy</b> ${dy.toFixed(4)} <b>Δz</b> ${dz.toFixed(4)}</div>
      <div class="muted">A (${a.x.toFixed(3)}, ${a.y.toFixed(3)}, ${a.z.toFixed(3)})</div>
      <div class="muted">B (${b.x.toFixed(3)}, ${b.y.toFixed(3)}, ${b.z.toFixed(3)})</div>
    `);
  }

  private updateStatus(): void {
    const text = this.modeActive
      ? 'Click on the robot to drop a point. Click off to cancel.'
      : this.points.length === 2
        ? 'Measurement set. Click "Start measuring" for a new one.'
        : 'Click two points on the robot to measure distance.';
    this.setStatus(text);
  }

  private setStatus(text: string): void {
    const status = document.getElementById('measure-status');
    if (status) {
      status.textContent = text;
    }
  }
}

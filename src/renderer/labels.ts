import * as THREE from 'three';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

export type LabelsMode = 'off' | 'joints' | 'links' | 'both';

interface Entry {
  object: CSS2DObject;
  kind: 'joint' | 'link';
}

export class LabelsOverlay {
  private readonly renderer: CSS2DRenderer;
  private readonly entries = new Map<string, Entry>();
  private mode: LabelsMode = 'off';

  constructor(parent: HTMLElement) {
    this.renderer = new CSS2DRenderer();
    this.renderer.setSize(parent.clientWidth || 1, parent.clientHeight || 1);
    const domElement = this.renderer.domElement;
    domElement.classList.add('labels-layer');
    parent.appendChild(domElement);
  }

  setSize(width: number, height: number): void {
    this.renderer.setSize(width, height);
  }

  render(scene: THREE.Scene, camera: THREE.Camera): void {
    this.renderer.render(scene, camera);
  }

  setMode(mode: LabelsMode): void {
    this.mode = mode;
    this.refreshVisibility();
  }

  getMode(): LabelsMode {
    return this.mode;
  }

  visibleCount(kind: 'joint' | 'link'): number {
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.kind === kind && entry.object.visible) {
        count += 1;
      }
    }
    return count;
  }

  totalCount(): number {
    return this.entries.size;
  }

  clear(): void {
    for (const entry of this.entries.values()) {
      entry.object.parent?.remove(entry.object);
      entry.object.element.remove();
    }
    this.entries.clear();
  }

  addJoint(name: string, host: THREE.Object3D): void {
    if (!host) {
      return;
    }
    const div = document.createElement('div');
    div.className = 'label-3d label-3d-joint';
    div.textContent = name;
    const object = new CSS2DObject(div);
    host.add(object);
    this.entries.set(`joint:${name}`, { object, kind: 'joint' });
  }

  addLink(name: string, host: THREE.Object3D): void {
    if (!host) {
      return;
    }
    const div = document.createElement('div');
    div.className = 'label-3d label-3d-link';
    div.textContent = name;
    const object = new CSS2DObject(div);
    host.add(object);
    this.entries.set(`link:${name}`, { object, kind: 'link' });
  }

  private refreshVisibility(): void {
    const showJoints = this.mode === 'joints' || this.mode === 'both';
    const showLinks = this.mode === 'links' || this.mode === 'both';
    for (const entry of this.entries.values()) {
      const visible = entry.kind === 'joint' ? showJoints : showLinks;
      entry.object.visible = visible;
      entry.object.element.style.display = visible ? '' : 'none';
    }
  }
}

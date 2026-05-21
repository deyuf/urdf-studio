// Self-collision detection + highlighting feature.
//
// Owns the BVH-backed narrow-phase, the material indexes used to tint
// colliding links red, the disable_collisions / adjacency pruning, and the
// trailing-edge schedule loop. The renderer wires up the toggle checkbox
// and delegates lifecycle hooks (build / dispose / schedule).
//
// Pure decision helpers — canonicalPair, isAdjacent, planCollisionPairs
// (broad-phase candidate enumeration) — live in renderer/logic/selfCollision.ts
// alongside their unit tests; this module is the THREE / scene / DOM layer.

import * as THREE from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import type { URDFRobot } from 'urdf-loader/src/URDFClasses';
import type { DisableCollisionEntry, RobotMetadata, SemanticMetadata } from '../../core/types';
import {
  buildDisabledPairSet,
  canonicalPair,
  isAdjacent as isAdjacentPure
} from '../logic/selfCollision';

export interface SelfCollisionDeps {
  /** Mark the scene dirty so the next animation tick re-renders. */
  requestRedraw(): void;
  /** Optional test/diagnostic probe. */
  onStateChange?: () => void;
}

export interface CollisionContext {
  robot: URDFRobot;
  metadata: RobotMetadata;
  semantic: Pick<SemanticMetadata, 'disableCollisions'>;
}

export interface CollisionResult {
  pairs: Array<[string, string]>;
  links: Set<string>;
}

interface IndexedMesh {
  mesh: THREE.Mesh;
  ownerLink: string;
}

export class SelfCollision {
  private enabled = false;

  // BVH-indexed collision meshes, plus material indexes for tinting.
  private collisionMeshes = new Map<string, IndexedMesh>();
  private linkCollisionMaterials = new Map<string, THREE.MeshStandardMaterial[]>();
  private linkVisualMaterials = new Map<string, THREE.MeshStandardMaterial[]>();
  private originalVisualColors = new Map<THREE.MeshStandardMaterial, THREE.Color>();
  private highlightedLinks = new Set<string>();

  // Debounce: leading + trailing edge so a sustained slider drag highlights
  // the last frame too. The legacy implementation was leading-only — it could
  // miss the final state.
  private pendingScheduled = false;
  private rescheduleRequested = false;

  constructor(private readonly deps: SelfCollisionDeps) {}

  isEnabled(): boolean { return this.enabled; }

  /** Number of colliding meshes the broad/narrow phase has highlighted. */
  highlightedLinkCount(): number { return this.highlightedLinks.size; }

  /** Test probe — does the BVH index have any meshes loaded? */
  hasGeometryIndex(): boolean { return this.collisionMeshes.size > 0; }

  /** Test probe — how many BVH meshes are indexed? */
  geometryIndexSize(): number { return this.collisionMeshes.size; }

  /** Toggle the feature. Disabling clears the highlights immediately. */
  setEnabled(ctx: CollisionContext | undefined, enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.clearHighlights();
    } else if (ctx) {
      // Show the user current state immediately rather than waiting for the
      // next joint nudge.
      this.runOnce(ctx);
    }
    this.deps.onStateChange?.();
  }

  /** Schedule a narrow-phase pass on the next RAF. Multiple calls coalesce. */
  schedule(ctx: CollisionContext): void {
    if (!this.enabled) {
      return;
    }
    if (this.pendingScheduled) {
      this.rescheduleRequested = true;
      return;
    }
    this.pendingScheduled = true;
    requestAnimationFrame(() => {
      this.pendingScheduled = false;
      if (!this.enabled) {
        return;
      }
      this.runOnce(ctx);
      if (this.rescheduleRequested) {
        this.rescheduleRequested = false;
        // Trailing edge — re-arm so the final state after a burst of joint
        // changes is checked too.
        this.schedule(ctx);
      }
    });
  }

  /**
   * Build the per-link material + BVH indexes after a robot is loaded /
   * collision geometry has streamed in. Safe to call repeatedly: clears
   * before rebuilding.
   */
  rebuildIndex(robot: URDFRobot): void {
    this.disposeIndex();
    this.indexCollisionMeshes(robot);
    this.indexVisualMaterials(robot);
  }

  /** Reset highlights to the visible material's default and wipe indexes. */
  dispose(): void {
    this.clearHighlights();
    this.disposeIndex();
    this.deps.onStateChange?.();
  }

  /** Just clear highlights without losing the indexes. */
  clearHighlights(): void {
    this.applyHighlights(new Set(), 0);
  }

  /**
   * Compute colliding pairs without touching highlights. Used by the
   * Tools-panel collision-pair sampler that drives the robot through random
   * poses; the sampler does NOT want the user to see the highlight flicker.
   */
  computeCollisions(ctx: CollisionContext): CollisionResult {
    return this.collect(ctx);
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private runOnce(ctx: CollisionContext): void {
    const result = this.collect(ctx);
    this.applyHighlights(result.links, result.pairs.length);
  }

  private collect(ctx: CollisionContext): CollisionResult {
    const pairs: Array<[string, string]> = [];
    const links = new Set<string>();
    if (this.collisionMeshes.size === 0) {
      return { pairs, links };
    }
    ctx.robot.updateMatrixWorld(true);

    const disabled = buildDisabledPairSet(ctx.semantic.disableCollisions as DisableCollisionEntry[]);
    const seenPair = new Set<string>();
    const meshes = Array.from(this.collisionMeshes.values());

    // World-space AABB cache per mesh (broad phase).
    const worldBoxes = new Map<string, THREE.Box3>();
    for (const entry of meshes) {
      worldBoxes.set(entry.mesh.uuid, new THREE.Box3().setFromObject(entry.mesh));
    }

    for (let i = 0; i < meshes.length; i += 1) {
      for (let j = i + 1; j < meshes.length; j += 1) {
        const a = meshes[i];
        const b = meshes[j];
        if (a.ownerLink === b.ownerLink) {
          continue;
        }
        const key = canonicalPair(a.ownerLink, b.ownerLink);
        if (seenPair.has(key) || disabled.has(key)) {
          continue;
        }
        if (isAdjacentPure(a.ownerLink, b.ownerLink, ctx.metadata.links, ctx.metadata.joints)) {
          continue;
        }
        const boxA = worldBoxes.get(a.mesh.uuid)!;
        const boxB = worldBoxes.get(b.mesh.uuid)!;
        if (!boxA.intersectsBox(boxB)) {
          continue;
        }
        const geomA = a.mesh.geometry as THREE.BufferGeometry & { boundsTree?: MeshBVH };
        const geomB = b.mesh.geometry as THREE.BufferGeometry & { boundsTree?: MeshBVH };
        if (!geomA.boundsTree || !geomB.boundsTree) {
          continue;
        }
        a.mesh.updateMatrixWorld(true);
        b.mesh.updateMatrixWorld(true);
        const inverseB = new THREE.Matrix4().copy(b.mesh.matrixWorld).invert();
        const aToB = new THREE.Matrix4().multiplyMatrices(inverseB, a.mesh.matrixWorld);
        if (geomA.boundsTree.intersectsGeometry(geomB, aToB)) {
          seenPair.add(key);
          pairs.push([a.ownerLink, b.ownerLink]);
          links.add(a.ownerLink);
          links.add(b.ownerLink);
        }
      }
    }
    return { pairs, links };
  }

  private applyHighlights(links: Set<string>, pairCount: number): void {
    // Restore links that were tinted last frame but aren't colliding now.
    for (const link of this.highlightedLinks) {
      if (!links.has(link)) {
        this.restoreLinkColors(link);
      }
    }
    // Tint links that are colliding — on both visual + collision materials so
    // the highlight survives a render-mode switch.
    for (const link of links) {
      this.tintLinkRed(link);
    }
    this.highlightedLinks.clear();
    for (const link of links) {
      this.highlightedLinks.add(link);
    }
    this.updateHud(pairCount);
    this.deps.requestRedraw();
    this.deps.onStateChange?.();
  }

  private tintLinkRed(linkName: string): void {
    for (const material of this.linkCollisionMaterials.get(linkName) ?? []) {
      material.color.set(0xff4040);
      material.needsUpdate = true;
    }
    for (const material of this.linkVisualMaterials.get(linkName) ?? []) {
      material.color.set(0xff4040);
      material.needsUpdate = true;
    }
  }

  private restoreLinkColors(linkName: string): void {
    // Collision meshes are recoloured cyan by the renderer's applyRenderMode;
    // just match that.
    for (const material of this.linkCollisionMaterials.get(linkName) ?? []) {
      material.color.set(0x71d0ff);
      material.needsUpdate = true;
    }
    for (const material of this.linkVisualMaterials.get(linkName) ?? []) {
      const original = this.originalVisualColors.get(material);
      if (original) {
        material.color.copy(original);
      }
      material.needsUpdate = true;
    }
  }

  private updateHud(pairCount: number): void {
    const hud = document.getElementById('collide-hud');
    if (!hud) {
      return;
    }
    if (!this.enabled) {
      hud.textContent = '';
      return;
    }
    hud.textContent = pairCount === 0
      ? 'No self-collisions.'
      : `${pairCount} self-collision pair${pairCount === 1 ? '' : 's'}.`;
  }

  // -------------------------------------------------------------------------
  // Indexing
  // -------------------------------------------------------------------------

  private indexCollisionMeshes(robot: URDFRobot): void {
    if (!robot.colliders) {
      return;
    }
    for (const [linkName, collider] of Object.entries(robot.colliders)) {
      collider.traverse(child => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh || !(mesh.geometry instanceof THREE.BufferGeometry)) {
          return;
        }
        const geometry = mesh.geometry as THREE.BufferGeometry & {
          boundsTree?: MeshBVH;
          computeBoundsTree?: () => void;
        };
        if (!geometry.boundsTree) {
          try {
            geometry.computeBoundsTree?.();
          } catch {
            return;
          }
        }
        this.collisionMeshes.set(`${linkName}::${mesh.uuid}`, { mesh, ownerLink: linkName });
        if (!this.linkCollisionMaterials.has(linkName)) {
          this.linkCollisionMaterials.set(linkName, []);
        }
        for (const material of materials(mesh)) {
          this.linkCollisionMaterials.get(linkName)!.push(material as THREE.MeshStandardMaterial);
        }
      });
    }
  }

  private indexVisualMaterials(robot: URDFRobot): void {
    if (!robot.visual) {
      return;
    }
    for (const [linkName, visual] of Object.entries(robot.visual)) {
      const collected: THREE.MeshStandardMaterial[] = [];
      visual.traverse(child => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) {
          return;
        }
        for (const material of materials(mesh) as THREE.MeshStandardMaterial[]) {
          collected.push(material);
          if (!this.originalVisualColors.has(material)) {
            this.originalVisualColors.set(material, material.color.clone());
          }
        }
      });
      if (collected.length > 0) {
        this.linkVisualMaterials.set(linkName, collected);
      }
    }
  }

  private disposeIndex(): void {
    this.collisionMeshes.clear();
    this.linkCollisionMaterials.clear();
    this.linkVisualMaterials.clear();
    this.originalVisualColors.clear();
  }
}

function materials(mesh: THREE.Mesh): THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

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
  private originalCollisionColors = new Map<THREE.MeshStandardMaterial, THREE.Color>();
  private highlightedLinks = new Set<string>();
  private lastPairs: Array<[string, string]> = [];

  // Debounce: leading + trailing edge so a sustained slider drag highlights
  // the last frame too. The legacy implementation was leading-only — it could
  // miss the final state.
  private pendingScheduled = false;
  private rescheduleRequested = false;

  constructor(private readonly deps: SelfCollisionDeps) {}

  isEnabled(): boolean { return this.enabled; }

  /** Link pairs found colliding by the last live check. */
  collidingPairs(): Array<[string, string]> { return this.lastPairs.map(([a, b]) => [a, b]); }

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
    this.applyHighlights(new Set(), []);
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
    this.applyHighlights(result.links, result.pairs);
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

  private applyHighlights(links: Set<string>, pairs: Array<[string, string]>): void {
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
    this.lastPairs = pairs;
    this.updateHud(pairs);
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
    for (const material of this.linkCollisionMaterials.get(linkName) ?? []) {
      const original = this.originalCollisionColors.get(material);
      if (original) {
        material.color.copy(original);
      }
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

  private updateHud(pairs: Array<[string, string]>): void {
    const hud = document.getElementById('collide-hud');
    if (!hud) {
      return;
    }
    if (!this.enabled) {
      hud.textContent = '';
      return;
    }
    // Name the colliding links: a bare count can't tell a real problem from
    // expected contact (e.g. closed gripper fingers).
    const shown = pairs.slice(0, 3).map(([a, b]) => `${a} ↔ ${b}`).join(', ');
    const more = pairs.length > 3 ? ` and ${pairs.length - 3} more` : '';
    hud.textContent = pairs.length === 0 ? 'No self-collisions.' : `Self-collision: ${shown}${more}`;
    hud.title = pairs.map(([a, b]) => `${a} ↔ ${b}`).join('\n');
  }

  // -------------------------------------------------------------------------
  // Indexing
  // -------------------------------------------------------------------------

  private indexCollisionMeshes(robot: URDFRobot): void {
    for (const [linkName, colliders] of linkGeometry(robot, 'isURDFCollider')) {
      for (const collider of colliders) collider.traverse(child => {
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
        for (const material of materials(mesh) as THREE.MeshStandardMaterial[]) {
          this.linkCollisionMaterials.get(linkName)!.push(material);
          if (!this.originalCollisionColors.has(material)) {
            this.originalCollisionColors.set(material, material.color.clone());
          }
        }
      });
    }
  }

  /** Links that have at least one collision mesh in the index. */
  linksWithCollisionGeometry(): Set<string> {
    return new Set(Array.from(this.collisionMeshes.values(), entry => entry.ownerLink));
  }

  private indexVisualMaterials(robot: URDFRobot): void {
    for (const [linkName, visuals] of linkGeometry(robot, 'isURDFVisual')) {
      const collected: THREE.MeshStandardMaterial[] = [];
      for (const visual of visuals) visual.traverse(child => {
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
    this.originalCollisionColors.clear();
  }
}

/**
 * Each link's own <collision> or <visual> groups, keyed by link name.
 *
 * urdf-loader's robot.colliders / robot.visual maps are keyed by the optional
 * `name` attribute of the <collision>/<visual> element: unnamed elements are
 * missing from them, and named ones are keyed by the element's name rather
 * than its link's. Walking each link's direct children avoids both problems
 * (a link's child links hang off its joints, so they are not included).
 */
export function linkGeometry(robot: URDFRobot, flag: 'isURDFCollider' | 'isURDFVisual'): Map<string, THREE.Object3D[]> {
  const out = new Map<string, THREE.Object3D[]>();
  for (const [linkName, link] of Object.entries(robot.links ?? {})) {
    const groups = (link as THREE.Object3D).children.filter(child => (child as THREE.Object3D & Record<string, unknown>)[flag] === true);
    if (groups.length > 0) {
      out.set(linkName, groups);
    }
  }
  return out;
}

function materials(mesh: THREE.Mesh): THREE.Material[] {
  return Array.isArray(mesh.material) ? mesh.material : [mesh.material];
}

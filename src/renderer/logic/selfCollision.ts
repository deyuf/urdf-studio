// Self-collision bookkeeping extracted from the renderer for testability.
// The heavy geometric narrow-phase still lives in renderer/main.ts (it owns
// the three-mesh-bvh BVHs and THREE.Object3D matrices), but the pure
// decisions — which pairs to skip, how to deduplicate them, what the
// disabled set looks like — are here and covered by unit tests.

import type { DisableCollisionEntry, JointInfo, LinkInfo } from '../../core/types';

/** Return a canonical key for an unordered pair of link names. */
export function canonicalPair(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** Convert a list of `<disable_collisions>` entries into a Set of canonical pair keys. */
export function buildDisabledPairSet(entries: ReadonlyArray<DisableCollisionEntry> | undefined | null): Set<string> {
  const set = new Set<string>();
  if (!entries) {
    return set;
  }
  for (const entry of entries) {
    if (entry?.link1 && entry?.link2) {
      set.add(canonicalPair(entry.link1, entry.link2));
    }
  }
  return set;
}

/**
 * True when `linkA` is the direct parent or direct child of `linkB` in the
 * URDF tree. We skip BVH self-collision checks between adjacent links
 * because their meshes usually overlap at the joint by design.
 */
export function isAdjacent(
  linkA: string,
  linkB: string,
  links: Record<string, LinkInfo>,
  joints: Record<string, JointInfo>
): boolean {
  const a = links[linkA];
  const b = links[linkB];
  if (!a || !b) {
    return false;
  }
  if (a.parentJoint && joints[a.parentJoint]?.parent === linkB) {
    return true;
  }
  if (b.parentJoint && joints[b.parentJoint]?.parent === linkA) {
    return true;
  }
  return false;
}

/**
 * Compute which link pairs need narrow-phase collision testing. Takes the
 * full set of link-mesh pairs and excludes:
 *   - the trivial reflexive pairs (same owner link),
 *   - pairs already marked as `disable_collisions` in SRDF, and
 *   - pairs that are tree-adjacent.
 *
 * Returns canonical keys so the caller can iterate without redundancy.
 */
export function planCollisionPairs(options: {
  meshes: ReadonlyArray<{ ownerLink: string }>;
  links: Record<string, LinkInfo>;
  joints: Record<string, JointInfo>;
  disabledPairs: ReadonlySet<string>;
}): string[] {
  const { meshes, links, joints, disabledPairs } = options;
  const planned = new Set<string>();
  for (let i = 0; i < meshes.length; i += 1) {
    for (let j = i + 1; j < meshes.length; j += 1) {
      const a = meshes[i].ownerLink;
      const b = meshes[j].ownerLink;
      if (a === b) {
        continue;
      }
      const key = canonicalPair(a, b);
      if (disabledPairs.has(key)) {
        continue;
      }
      if (planned.has(key)) {
        continue;
      }
      if (isAdjacent(a, b, links, joints)) {
        continue;
      }
      planned.add(key);
    }
  }
  return Array.from(planned);
}

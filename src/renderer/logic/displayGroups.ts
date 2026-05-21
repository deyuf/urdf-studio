// Pure helpers extracted from src/renderer/main.ts to make joint-panel
// grouping decisions unit-testable. The renderer continues to own the DOM;
// these helpers only compute the shape of the panel.

import type { JointInfo, RobotMetadata, SemanticMetadata } from '../../core/types';

export interface DisplayGroup {
  name: string;
  joints: string[];
}

/**
 * Decide how joints should be grouped in the right-hand "Joints" panel.
 *
 *   1. If the loaded SRDF defines groups whose joints intersect the robot's
 *      movable joints, those groups win.
 *   2. Otherwise fall back to a heuristic that buckets joints by their
 *      underscore prefix (so `arm_left_*` and `arm_right_*` collapse into
 *      `arm`). Joints without underscores live under the catch-all `all`
 *      bucket.
 *
 * The function never mutates its inputs and never reads `Math.random`,
 * `Date.now`, or any globals; everything observable is a function of the
 * `metadata` / `semantic` pair.
 */
export function buildDisplayGroups(
  metadata: Pick<RobotMetadata, 'movableJointNames'>,
  semantic: Pick<SemanticMetadata, 'groups'>
): DisplayGroup[] {
  const movable = new Set(metadata.movableJointNames);
  const semanticGroups = semantic.groups
    .map(group => ({ name: group.name, joints: group.joints.filter(joint => movable.has(joint)) }))
    .filter(group => group.joints.length > 0);
  if (semanticGroups.length > 0) {
    return semanticGroups;
  }

  const grouped = new Map<string, string[]>();
  for (const joint of metadata.movableJointNames) {
    const prefix = joint.includes('_') ? joint.split('_')[0] : 'all';
    if (!grouped.has(prefix)) {
      grouped.set(prefix, []);
    }
    grouped.get(prefix)!.push(joint);
  }
  return Array.from(grouped.entries()).map(([name, joints]) => ({ name, joints }));
}

/**
 * Compute the slider [min, max] range for a joint. `continuous` joints get
 * a default ±π; `prismatic` joints without explicit limits get ±1 (1 metre,
 * matching the legacy behaviour); revolute / floating / planar joints
 * without explicit limits get ±π.
 */
export function jointRange(joint: JointInfo | undefined): [number, number] {
  if (!joint || joint.type === 'continuous') {
    return [-Math.PI, Math.PI];
  }
  if (joint.limit.lower !== undefined && joint.limit.upper !== undefined) {
    return [joint.limit.lower, joint.limit.upper];
  }
  return joint.type === 'prismatic' ? [-1, 1] : [-Math.PI, Math.PI];
}

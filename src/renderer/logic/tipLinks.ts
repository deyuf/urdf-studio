// Candidate tip links for reachability sampling, best first.
//
// Leaf links include end effectors but also sensor frames and accessories
// hung off the base. Links named like a tool point (tcp, tool, ee, flange…)
// come first — the conventional reference for reach — then the rest. Within
// each group the end of the longest chain of *movable* joints wins (the part
// the arm actually moves); ties go to the deeper link overall, then name.

import type { RobotMetadata } from '../../core/types';

const TOOL_POINT = /(^|_)(tcp|tool\d*|ee|end_?effector|eef|flange|tip)(_|$)/i;

export function rankTipLinks(metadata: Pick<RobotMetadata, 'links' | 'joints'>): string[] {
  const depth = (linkName: string): { movable: number; total: number } => {
    let movable = 0;
    let total = 0;
    const seen = new Set<string>();
    let joint = metadata.links[linkName]?.parentJoint;
    while (joint && !seen.has(joint)) {
      seen.add(joint);
      const info = metadata.joints[joint];
      if (!info) break;
      total += 1;
      if (info.type !== 'fixed') movable += 1;
      joint = info.parent ? metadata.links[info.parent]?.parentJoint : undefined;
    }
    return { movable, total };
  };
  return Object.values(metadata.links)
    .filter(link => link.childJoints.length === 0)
    .map(link => ({ name: link.name, tool: TOOL_POINT.test(link.name) ? 1 : 0, ...depth(link.name) }))
    .sort((a, b) => b.tool - a.tool || b.movable - a.movable || b.total - a.total || a.name.localeCompare(b.name))
    .map(entry => entry.name);
}

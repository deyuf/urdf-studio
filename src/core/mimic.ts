import type { JointInfo } from './types';

export interface MimicGraph {
  followers: Map<string, JointInfo[]>;
}

export function buildMimicGraph(joints: Record<string, JointInfo>): MimicGraph {
  const followers = new Map<string, JointInfo[]>();
  for (const joint of Object.values(joints)) {
    if (!joint.mimic) {
      continue;
    }
    if (!followers.has(joint.mimic.joint)) {
      followers.set(joint.mimic.joint, []);
    }
    followers.get(joint.mimic.joint)!.push(joint);
  }
  return { followers };
}

export function propagateMimicValue(
  graph: MimicGraph,
  master: string,
  masterValue: number
): Array<{ joint: string; value: number }> {
  const result: Array<{ joint: string; value: number }> = [];
  const visited = new Set<string>();

  const walk = (jointName: string, value: number) => {
    if (visited.has(jointName)) {
      return;
    }
    visited.add(jointName);
    const followers = graph.followers.get(jointName) ?? [];
    for (const follower of followers) {
      if (!follower.mimic) {
        continue;
      }
      const followerValue = value * follower.mimic.multiplier + follower.mimic.offset;
      result.push({ joint: follower.name, value: followerValue });
      walk(follower.name, followerValue);
    }
  };

  walk(master, masterValue);
  return result;
}

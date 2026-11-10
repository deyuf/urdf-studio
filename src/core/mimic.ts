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
  // The master is visited from the start, so a mimic cycle (or a joint that
  // mimics itself) can never feed a value back into the joint being moved.
  // Iterative so very long mimic chains cannot overflow the stack.
  const visited = new Set<string>([master]);
  const pending: Array<{ joint: string; value: number }> = [{ joint: master, value: masterValue }];
  for (let index = 0; index < pending.length; index += 1) {
    const { joint, value } = pending[index];
    for (const follower of graph.followers.get(joint) ?? []) {
      if (!follower.mimic || visited.has(follower.name)) {
        continue;
      }
      visited.add(follower.name);
      const followerValue = value * follower.mimic.multiplier + follower.mimic.offset;
      result.push({ joint: follower.name, value: followerValue });
      pending.push({ joint: follower.name, value: followerValue });
    }
  }
  return result;
}

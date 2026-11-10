// Make a structurally broken URDF drawable.
//
// The 3D loader (urdf-loader) assumes a well-formed tree: a joint whose
// parent link is missing makes it call `.add` on undefined, a mimic of an
// unknown joint dereferences undefined, and a cycle produces a scene graph
// loop. The Checks panel already reports all of these, so instead of
// refusing to draw anything we drop only the offending elements and draw
// the rest. The source text shown to the user is never touched — this
// copy only feeds the renderer.

import { XMLSerializer } from '@xmldom/xmldom';
import { directChildren, firstDirectChild, parseXml } from './xml';

export interface RenderableResult {
  /** URDF safe to hand to the loader (the input itself when nothing changed). */
  urdf: string;
  /** Human-readable descriptions of what was left out, in document order. */
  removed: string[];
}

export function makeRenderable(urdf: string): RenderableResult {
  let doc: Document;
  try {
    doc = parseXml(urdf, 'URDF');
  } catch {
    // Unparseable text is reported elsewhere; let the loader produce its own
    // error rather than guessing.
    return { urdf, removed: [] };
  }
  const robot = doc.documentElement;
  if (!robot || robot.tagName !== 'robot') {
    return { urdf, removed: [] };
  }

  const removed: string[] = [];
  const drop = (element: Element, reason: string): void => {
    element.parentNode?.removeChild(element);
    removed.push(reason);
  };

  // Links: unnamed or duplicate links would be silently merged or shadowed.
  const linkNames = new Set<string>();
  for (const link of directChildren(robot, 'link')) {
    const name = link.getAttribute('name');
    if (!name) {
      drop(link, 'a link without a name');
    } else if (linkNames.has(name)) {
      drop(link, `duplicate link "${name}"`);
    } else {
      linkNames.add(name);
    }
  }

  // Joints: each must connect two existing, distinct links, and each link
  // may have only one parent joint.
  const jointNames = new Set<string>();
  const parentOf = new Map<string, { parent: string; joint: Element; name: string }>();
  for (const joint of directChildren(robot, 'joint')) {
    const name = joint.getAttribute('name') ?? '';
    const parent = firstDirectChild(joint, 'parent')?.getAttribute('link') ?? '';
    const child = firstDirectChild(joint, 'child')?.getAttribute('link') ?? '';
    const label = name ? `joint "${name}"` : 'a joint without a name';
    if (!name) {
      drop(joint, label);
    } else if (jointNames.has(name)) {
      drop(joint, `duplicate joint "${name}"`);
    } else if (!linkNames.has(parent) || !linkNames.has(child)) {
      drop(joint, `${label} (links to a missing link)`);
    } else if (parent === child) {
      drop(joint, `${label} (attaches a link to itself)`);
    } else if (parentOf.has(child)) {
      drop(joint, `${label} (second parent of "${child}")`);
    } else {
      jointNames.add(name);
      parentOf.set(child, { parent, joint, name });
    }
  }

  // Cycles: with at most one parent per link, every cycle is a loop in the
  // parent chain. Walk up from each link; when the walk revisits a link on
  // the current path, cut the joint that closed the loop.
  const settled = new Set<string>();
  for (const start of linkNames) {
    const path: string[] = [];
    const onPath = new Set<string>();
    let cursor: string | undefined = start;
    while (cursor !== undefined && !settled.has(cursor)) {
      if (onPath.has(cursor)) {
        const closing = parentOf.get(cursor);
        if (closing) {
          drop(closing.joint, `joint "${closing.name}" (closes a loop)`);
          parentOf.delete(cursor);
          jointNames.delete(closing.name);
        }
        break;
      }
      onPath.add(cursor);
      path.push(cursor);
      cursor = parentOf.get(cursor)?.parent;
    }
    for (const link of path) {
      settled.add(link);
    }
  }

  // Mimics: must point at a remaining joint, and must not form a loop.
  const mimicTarget = new Map<string, { target: string; element: Element }>();
  for (const joint of directChildren(robot, 'joint')) {
    const mimic = firstDirectChild(joint, 'mimic');
    if (!mimic) continue;
    const name = joint.getAttribute('name') ?? '';
    const target = mimic.getAttribute('joint') ?? '';
    if (!jointNames.has(target) || target === name) {
      drop(mimic, `mimic on joint "${name}" (follows a missing joint)`);
    } else {
      mimicTarget.set(name, { target, element: mimic });
    }
  }
  for (const start of [...mimicTarget.keys()]) {
    const seen = new Set<string>();
    let cursor: string | undefined = start;
    while (cursor !== undefined && mimicTarget.has(cursor)) {
      if (seen.has(cursor)) {
        const entry = mimicTarget.get(cursor)!;
        drop(entry.element, `mimic on joint "${cursor}" (mimic loop)`);
        mimicTarget.delete(cursor);
        break;
      }
      seen.add(cursor);
      cursor = mimicTarget.get(cursor)?.target;
    }
  }

  if (removed.length === 0) {
    return { urdf, removed };
  }
  return { urdf: new XMLSerializer().serializeToString(doc), removed };
}

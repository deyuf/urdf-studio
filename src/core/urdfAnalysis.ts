import { existsSync } from 'node:fs';
import path from 'node:path';
import { directChildren, firstDirectChild, lineForNeedle, parseXml, readNumber, readVector } from './xml';
import { resolveModelUriToFile } from './packageMap';
import type { JointInfo, LinkInfo, LinkTreeNode, PackageMap, RobotMetadata, StudioDiagnostic } from './types';

const MOVABLE_JOINT_TYPES = new Set(['revolute', 'continuous', 'prismatic', 'floating', 'planar']);

export function analyzeUrdf(urdf: string, sourcePath: string, packages: PackageMap): RobotMetadata {
  const diagnostics: StudioDiagnostic[] = [];
  let doc: Document;
  try {
    doc = parseXml(urdf, sourcePath);
  } catch (error) {
    return emptyMetadata(String(error), sourcePath);
  }

  const robot = doc.documentElement;
  const robotName = robot.getAttribute('name') || path.basename(sourcePath);
  const documentDir = path.dirname(sourcePath);
  const links: Record<string, LinkInfo> = {};
  const joints: Record<string, JointInfo> = {};
  const childToParentJoint = new Map<string, string>();
  const parentToChildren = new Map<string, Array<{ joint: string; child: string }>>();

  for (const link of directChildren(robot, 'link')) {
    const name = link.getAttribute('name')?.trim();
    if (!name) {
      diagnostics.push({ severity: 'error', message: 'Link without a name attribute.', code: 'link.missingName', file: sourcePath });
      continue;
    }
    if (links[name]) {
      diagnostics.push({ severity: 'error', message: `Duplicate link "${name}".`, code: 'link.duplicate', target: name, file: sourcePath, line: lineForNeedle(urdf, `<link name="${name}"`) });
    }
    links[name] = {
      name,
      childJoints: [],
      line: lineForNeedle(urdf, `<link name="${name}"`)
    };
  }

  for (const joint of directChildren(robot, 'joint')) {
    const name = joint.getAttribute('name')?.trim();
    const type = joint.getAttribute('type')?.trim() || 'fixed';
    if (!name) {
      diagnostics.push({ severity: 'error', message: 'Joint without a name attribute.', code: 'joint.missingName', file: sourcePath });
      continue;
    }
    if (joints[name]) {
      diagnostics.push({ severity: 'error', message: `Duplicate joint "${name}".`, code: 'joint.duplicate', target: name, file: sourcePath, line: lineForNeedle(urdf, `<joint name="${name}"`) });
    }

    const parent = firstDirectChild(joint, 'parent')?.getAttribute('link')?.trim();
    const child = firstDirectChild(joint, 'child')?.getAttribute('link')?.trim();
    const axis = readVector(firstDirectChild(joint, 'axis')?.getAttribute('xyz'), [1, 0, 0]);
    const limitElement = firstDirectChild(joint, 'limit');
    const info: JointInfo = {
      name,
      type,
      parent,
      child,
      axis,
      limit: {
        lower: readNumber(limitElement?.getAttribute('lower')),
        upper: readNumber(limitElement?.getAttribute('upper')),
        effort: readNumber(limitElement?.getAttribute('effort')),
        velocity: readNumber(limitElement?.getAttribute('velocity'))
      },
      line: lineForNeedle(urdf, `<joint name="${name}"`)
    };
    joints[name] = info;

    if (!parent || !links[parent]) {
      diagnostics.push({ severity: 'error', message: `Joint "${name}" references missing parent link "${parent ?? ''}".`, code: 'joint.parentMissing', target: name, file: sourcePath, line: info.line });
    }
    if (!child || !links[child]) {
      diagnostics.push({ severity: 'error', message: `Joint "${name}" references missing child link "${child ?? ''}".`, code: 'joint.childMissing', target: name, file: sourcePath, line: info.line });
    }
    if (child) {
      if (childToParentJoint.has(child)) {
        diagnostics.push({ severity: 'error', message: `Link "${child}" has more than one parent joint.`, code: 'tree.multipleParents', target: child, file: sourcePath, line: info.line });
      }
      childToParentJoint.set(child, name);
      if (links[child]) {
        links[child].parentJoint = name;
      }
    }
    if (parent && child) {
      if (!parentToChildren.has(parent)) {
        parentToChildren.set(parent, []);
      }
      parentToChildren.get(parent)?.push({ joint: name, child });
      if (links[parent]) {
        links[parent].childJoints.push(name);
      }
    }

    if ((type === 'revolute' || type === 'prismatic') && (info.limit.lower === undefined || info.limit.upper === undefined)) {
      diagnostics.push({ severity: 'warning', message: `Movable joint "${name}" is missing lower or upper limits.`, code: 'joint.limitMissing', target: name, file: sourcePath, line: info.line });
    }
    if (info.limit.lower !== undefined && info.limit.upper !== undefined && info.limit.lower > info.limit.upper) {
      diagnostics.push({ severity: 'error', message: `Joint "${name}" lower limit is greater than upper limit.`, code: 'joint.limitInvalid', target: name, file: sourcePath, line: info.line });
    }
  }

  const meshes = directChildren(robot, 'link').flatMap(link => {
    const linkName = link.getAttribute('name')?.trim() ?? '';
    return (['visual', 'collision'] as const).flatMap(kind => directChildren(link, kind).flatMap(visualOrCollision => {
      const geometry = firstDirectChild(visualOrCollision, 'geometry');
      const mesh = geometry ? firstDirectChild(geometry, 'mesh') : undefined;
      const filename = mesh?.getAttribute('filename')?.trim();
      if (!filename) {
        return [];
      }
      const resolved = resolveModelUriToFile(filename, packages, documentDir);
      const exists = resolved.resolvedPath ? existsSync(resolved.resolvedPath) : false;
      const line = lineForNeedle(urdf, filename);
      if (filename.startsWith('package://') && !resolved.packageName) {
        diagnostics.push({ severity: 'error', message: `Mesh URI "${filename}" has no package name.`, code: 'mesh.packageMalformed', target: linkName, file: sourcePath, line });
      } else if (filename.startsWith('package://') && resolved.packageName && !packages[resolved.packageName]) {
        diagnostics.push({ severity: 'error', message: `Missing ROS package "${resolved.packageName}" for mesh "${filename}".`, code: 'mesh.packageMissing', target: linkName, file: sourcePath, line });
      } else if (resolved.resolvedPath && !exists) {
        diagnostics.push({ severity: 'error', message: `Missing ${kind} mesh "${filename}".`, code: 'mesh.missing', target: linkName, file: sourcePath, line });
      }
      return [{
        link: linkName,
        kind,
        filename,
        packageName: resolved.packageName,
        resolvedPath: resolved.resolvedPath,
        exists,
        line
      }];
    }));
  });

  const rootLinks = Object.keys(links).filter(link => !childToParentJoint.has(link));
  if (rootLinks.length !== 1) {
    diagnostics.push({ severity: 'warning', message: `Expected one root link, found ${rootLinks.length}: ${rootLinks.join(', ') || 'none'}.`, code: 'tree.rootCount', file: sourcePath });
  }
  diagnostics.push(...detectCycles(links, parentToChildren, sourcePath));

  const tree = rootLinks.length > 0
    ? rootLinks.map(rootLink => buildTree(rootLink, parentToChildren, new Set()))
    : Object.keys(links).slice(0, 1).map(rootLink => buildTree(rootLink, parentToChildren, new Set()));
  const movableJointNames = Object.values(joints)
    .filter(joint => MOVABLE_JOINT_TYPES.has(joint.type))
    .map(joint => joint.name);

  return {
    robotName,
    counts: {
      links: Object.keys(links).length,
      joints: Object.keys(joints).length,
      movableJoints: movableJointNames.length,
      visualMeshes: meshes.filter(mesh => mesh.kind === 'visual').length,
      collisionMeshes: meshes.filter(mesh => mesh.kind === 'collision').length
    },
    links,
    joints,
    meshes,
    rootLinks,
    movableJointNames,
    tree,
    diagnostics
  };
}

function emptyMetadata(message: string, file: string): RobotMetadata {
  return {
    robotName: 'Invalid URDF',
    counts: { links: 0, joints: 0, movableJoints: 0, visualMeshes: 0, collisionMeshes: 0 },
    links: {},
    joints: {},
    meshes: [],
    rootLinks: [],
    movableJointNames: [],
    tree: [],
    diagnostics: [{ severity: 'error', message, code: 'xml.parse', file }]
  };
}

function buildTree(link: string, children: Map<string, Array<{ joint: string; child: string }>>, seen: Set<string>): LinkTreeNode {
  if (seen.has(link)) {
    return { link, children: [] };
  }
  seen.add(link);
  return {
    link,
    children: (children.get(link) ?? []).map(child => ({
      ...buildTree(child.child, children, new Set(seen)),
      joint: child.joint
    }))
  };
}

function detectCycles(
  links: Record<string, LinkInfo>,
  children: Map<string, Array<{ joint: string; child: string }>>,
  file: string
): StudioDiagnostic[] {
  const diagnostics: StudioDiagnostic[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();

  const visit = (link: string, path: string[]) => {
    if (visiting.has(link)) {
      diagnostics.push({
        severity: 'error',
        message: `Cycle detected in link tree: ${[...path, link].join(' -> ')}.`,
        code: 'tree.cycle',
        target: link,
        file
      });
      return;
    }
    if (visited.has(link)) {
      return;
    }
    visiting.add(link);
    for (const child of children.get(link) ?? []) {
      visit(child.child, [...path, link]);
    }
    visiting.delete(link);
    visited.add(link);
  };

  for (const link of Object.keys(links)) {
    visit(link, []);
  }

  return diagnostics;
}


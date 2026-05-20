import { directChildren, firstDirectChild, lineForNeedle, parseXml, readNumber, readVector } from './xml';
import { resolveModelUriToFile } from './packageMap';
import { inertiaEigenvalues } from './inertia';
import { getCoreIo } from './io';
import type { InertialInfo, JointInfo, LinkInfo, LinkTreeNode, MimicInfo, PackageMap, RobotMetadata, StudioDiagnostic } from './types';

export { inertiaEigenvalues, ellipsoidSemiAxes } from './inertia';

const MOVABLE_JOINT_TYPES = new Set(['revolute', 'continuous', 'prismatic', 'floating', 'planar']);

export function analyzeUrdf(urdf: string, sourcePath: string, packages: PackageMap): RobotMetadata {
  const io = getCoreIo();
  const diagnostics: StudioDiagnostic[] = [];
  let doc: Document;
  try {
    doc = parseXml(urdf, sourcePath);
  } catch (error) {
    return emptyMetadata(String(error), sourcePath);
  }

  const robot = doc.documentElement;
  const robotName = robot.getAttribute('name') || io.basename(sourcePath);
  const documentDir = io.dirname(sourcePath);
  const links: Record<string, LinkInfo> = {};
  const joints: Record<string, JointInfo> = {};
  const childToParentJoint = new Map<string, string>();
  const parentToChildren = new Map<string, Array<{ joint: string; child: string }>>();
  let totalMass = 0;

  for (const link of directChildren(robot, 'link')) {
    const name = link.getAttribute('name')?.trim();
    if (!name) {
      diagnostics.push({ severity: 'error', message: 'Link without a name attribute.', code: 'link.missingName', file: sourcePath });
      continue;
    }
    if (links[name]) {
      diagnostics.push({ severity: 'error', message: `Duplicate link "${name}".`, code: 'link.duplicate', target: name, file: sourcePath, line: lineForNeedle(urdf, `<link name="${name}"`) });
    }
    const inertial = parseInertial(link, name, sourcePath, diagnostics);
    if (inertial) {
      totalMass += inertial.mass;
    }
    links[name] = {
      name,
      childJoints: [],
      inertial,
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
    const mimic = parseMimic(joint);
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
      mimic,
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

    if ((type === 'revolute' || type === 'prismatic') && !mimic && (info.limit.lower === undefined || info.limit.upper === undefined)) {
      diagnostics.push({ severity: 'warning', message: `Movable joint "${name}" is missing lower or upper limits.`, code: 'joint.limitMissing', target: name, file: sourcePath, line: info.line });
    }
    if (info.limit.lower !== undefined && info.limit.upper !== undefined && info.limit.lower > info.limit.upper) {
      diagnostics.push({ severity: 'error', message: `Joint "${name}" lower limit is greater than upper limit.`, code: 'joint.limitInvalid', target: name, file: sourcePath, line: info.line });
    }
  }

  for (const joint of Object.values(joints)) {
    if (joint.mimic && !joints[joint.mimic.joint]) {
      diagnostics.push({ severity: 'warning', message: `Joint "${joint.name}" mimics unknown joint "${joint.mimic.joint}".`, code: 'joint.mimicMissing', target: joint.name, file: sourcePath, line: joint.line });
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
      const exists = resolved.resolvedPath ? io.existsSync(resolved.resolvedPath) : false;
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
    .filter(joint => MOVABLE_JOINT_TYPES.has(joint.type) && !joint.mimic)
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
    totalMass,
    diagnostics
  };
}

function parseMimic(jointElement: Element): MimicInfo | undefined {
  const mimicElement = firstDirectChild(jointElement, 'mimic');
  if (!mimicElement) {
    return undefined;
  }
  const joint = mimicElement.getAttribute('joint')?.trim();
  if (!joint) {
    return undefined;
  }
  const multiplier = readNumber(mimicElement.getAttribute('multiplier'));
  const offset = readNumber(mimicElement.getAttribute('offset'));
  return {
    joint,
    multiplier: multiplier ?? 1,
    offset: offset ?? 0
  };
}

function parseInertial(linkElement: Element, linkName: string, sourcePath: string, diagnostics: StudioDiagnostic[]): InertialInfo | undefined {
  const inertial = firstDirectChild(linkElement, 'inertial');
  if (!inertial) {
    return undefined;
  }
  const mass = readNumber(firstDirectChild(inertial, 'mass')?.getAttribute('value'));
  const origin = firstDirectChild(inertial, 'origin');
  const inertia = firstDirectChild(inertial, 'inertia');
  if (mass === undefined || mass <= 0) {
    diagnostics.push({ severity: 'warning', message: `Link "${linkName}" has missing or non-positive mass.`, code: 'inertial.massInvalid', target: linkName, file: sourcePath });
  }
  if (!inertia) {
    diagnostics.push({ severity: 'warning', message: `Link "${linkName}" inertial has no <inertia> tensor.`, code: 'inertial.tensorMissing', target: linkName, file: sourcePath });
  }
  const ixx = readNumber(inertia?.getAttribute('ixx')) ?? 0;
  const ixy = readNumber(inertia?.getAttribute('ixy')) ?? 0;
  const ixz = readNumber(inertia?.getAttribute('ixz')) ?? 0;
  const iyy = readNumber(inertia?.getAttribute('iyy')) ?? 0;
  const iyz = readNumber(inertia?.getAttribute('iyz')) ?? 0;
  const izz = readNumber(inertia?.getAttribute('izz')) ?? 0;

  if (mass !== undefined && mass > 0 && inertia) {
    const eigenvalues = inertiaEigenvalues({ ixx, ixy, ixz, iyy, iyz, izz });
    if (eigenvalues.some(value => value <= 0)) {
      diagnostics.push({ severity: 'warning', message: `Link "${linkName}" inertia tensor is not positive-definite.`, code: 'inertial.notPositiveDefinite', target: linkName, file: sourcePath });
    }
  }

  return {
    mass: mass ?? 0,
    origin: readVector(origin?.getAttribute('xyz'), [0, 0, 0]),
    rotation: readVector(origin?.getAttribute('rpy'), [0, 0, 0]),
    ixx,
    ixy,
    ixz,
    iyy,
    iyz,
    izz
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
    totalMass: 0,
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

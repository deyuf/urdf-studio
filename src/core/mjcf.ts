// Read-only MJCF (MuJoCo XML) support.
//
// An MJCF model is converted into an equivalent URDF so the whole existing
// pipeline — analysis, checks, joint sliders, inspector, tools, exports —
// works on it unchanged. The conversion is for viewing: it keeps the
// kinematic tree, joint axes and limits, geometry, colours and inertia, and
// reports (as info diagnostics) anything URDF cannot express.
//
// Mapping:
//   <body>                → <link>, attached to its parent by a joint
//   hinge / slide joint   → revolute|continuous / prismatic
//   several joints        → a chain through intermediate links, one per joint
//   ball / free joint     → fixed (URDF has no equivalent; reported)
//   geom                  → <visual> when in groups 0–2, <collision> when it
//                           collides (contype/conaffinity not both 0)
//   capsule               → cylinder + two spheres
//   ellipsoid             → sphere of the largest radius (reported)
//
// MuJoCo resolves everything — includes, mesh files — relative to the main
// model file's folder (or compiler meshdir/assetdir), so emitted mesh paths
// are relative to that folder too and resolve like any relative URDF path.

import { getCoreIo } from './io';
import { escapeXmlAttr } from './escapeXml';
import { directChildren, parseXml } from './xml';
import type { StudioDiagnostic } from './types';

// ---------------------------------------------------------------------------
// Small rigid-body math. Quaternions are [w, x, y, z] like MuJoCo's.
// ---------------------------------------------------------------------------

type Vec3 = [number, number, number];
type Quat = [number, number, number, number];
interface Pose { pos: Vec3; quat: Quat }

const IDENTITY: Pose = { pos: [0, 0, 0], quat: [1, 0, 0, 0] };

function qmul(a: Quat, b: Quat): Quat {
  return [
    a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
    a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
    a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
    a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0]
  ];
}

function qnormalize(q: Quat): Quat {
  const n = Math.hypot(...q);
  return n > 0 ? [q[0] / n, q[1] / n, q[2] / n, q[3] / n] : [1, 0, 0, 0];
}

function qrotate(q: Quat, v: Vec3): Vec3 {
  const r = qmul(qmul(q, [0, v[0], v[1], v[2]]), [q[0], -q[1], -q[2], -q[3]]);
  return [r[1], r[2], r[3]];
}

function axisAngle(axis: Vec3, angle: number): Quat {
  const n = Math.hypot(...axis);
  if (n === 0) return [1, 0, 0, 0];
  const s = Math.sin(angle / 2) / n;
  return [Math.cos(angle / 2), axis[0] * s, axis[1] * s, axis[2] * s];
}

function fromMatrix(m: number[][]): Quat {
  // Shepperd's method on a row-major 3×3 rotation matrix.
  const trace = m[0][0] + m[1][1] + m[2][2];
  if (trace > 0) {
    const s = Math.sqrt(trace + 1) * 2;
    return qnormalize([0.25 * s, (m[2][1] - m[1][2]) / s, (m[0][2] - m[2][0]) / s, (m[1][0] - m[0][1]) / s]);
  }
  if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) {
    const s = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2;
    return qnormalize([(m[2][1] - m[1][2]) / s, 0.25 * s, (m[0][1] + m[1][0]) / s, (m[0][2] + m[2][0]) / s]);
  }
  if (m[1][1] > m[2][2]) {
    const s = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2;
    return qnormalize([(m[0][2] - m[2][0]) / s, (m[0][1] + m[1][0]) / s, 0.25 * s, (m[1][2] + m[2][1]) / s]);
  }
  const s = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2;
  return qnormalize([(m[1][0] - m[0][1]) / s, (m[0][2] + m[2][0]) / s, (m[1][2] + m[2][1]) / s, 0.25 * s]);
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}

function normalize(v: Vec3): Vec3 {
  const n = Math.hypot(...v);
  return n > 0 ? [v[0] / n, v[1] / n, v[2] / n] : [0, 0, 0];
}

/** Shortest rotation taking +Z onto `z`. */
function fromZAxis(z: Vec3): Quat {
  const target = normalize(z);
  if (Math.hypot(...target) === 0) return [1, 0, 0, 0];
  const dot = target[2];
  if (dot < -1 + 1e-12) return [0, 1, 0, 0];
  const axis = cross([0, 0, 1], target);
  return qnormalize([1 + dot, axis[0], axis[1], axis[2]]);
}

function compose(parent: Pose, child: Pose): Pose {
  const offset = qrotate(parent.quat, child.pos);
  return {
    pos: [parent.pos[0] + offset[0], parent.pos[1] + offset[1], parent.pos[2] + offset[2]],
    quat: qnormalize(qmul(parent.quat, child.quat))
  };
}

/** URDF rpy (fixed-axis X, then Y, then Z) for a quaternion. */
export function quatToRpy(q: Quat): Vec3 {
  const [w, x, y, z] = qnormalize(q);
  const m00 = 1 - 2 * (y * y + z * z);
  const m10 = 2 * (x * y + w * z);
  const m20 = 2 * (x * z - w * y);
  const m21 = 2 * (y * z + w * x);
  const m22 = 1 - 2 * (x * x + y * y);
  const m11 = 1 - 2 * (x * x + z * z);
  const m12 = 2 * (y * z - w * x);
  const pitch = Math.asin(Math.max(-1, Math.min(1, -m20)));
  if (Math.abs(m20) > 1 - 1e-9) {
    // Gimbal lock: yaw and roll share an axis; put it all in roll.
    return [Math.atan2(-m12, m11), pitch, 0];
  }
  return [Math.atan2(m21, m22), pitch, Math.atan2(m10, m00)];
}

// ---------------------------------------------------------------------------
// Attribute access with MuJoCo default classes.
// ---------------------------------------------------------------------------

type Attrs = Record<string, string>;
type DefaultSet = Record<string, Attrs>; // element tag → attributes

interface Compiler {
  degrees: boolean;
  eulerSeq: string;
  meshDir: string;
  autoLimits: boolean;
}

/** The attribute's value, or undefined when it is absent. (xmldom's
 *  getAttribute returns "" for a missing attribute, which would defeat `??`.) */
function optionalAttr(element: Element, name: string): string | undefined {
  return element.hasAttribute(name) ? element.getAttribute(name) ?? undefined : undefined;
}

function attrsOf(element: Element): Attrs {
  const out: Attrs = {};
  for (let i = 0; i < element.attributes.length; i += 1) {
    const attribute = element.attributes.item(i)!;
    out[attribute.name] = attribute.value;
  }
  return out;
}

function numbers(value: string | undefined): number[] | undefined {
  if (value === undefined || value.trim() === '') return undefined;
  const parts = value.trim().split(/\s+/).map(Number);
  return parts.every(Number.isFinite) ? parts : undefined;
}

function vec3(value: string | undefined, fallback: Vec3): Vec3 {
  const parts = numbers(value);
  return parts && parts.length >= 3 ? [parts[0], parts[1], parts[2]] : fallback;
}

// ---------------------------------------------------------------------------
// Conversion.
// ---------------------------------------------------------------------------

export interface MjcfConversion {
  urdf: string;
  diagnostics: StudioDiagnostic[];
  includedFiles: string[];
}

/** True when `content` is an MJCF document (root element <mujoco>). */
export function isMjcfContent(content: string): boolean {
  return /^\s*(<\?xml[^>]*\?>\s*)?(<!--[\s\S]*?-->\s*)*<mujoco[\s>/]/.test(content);
}

const MAX_INCLUDE_DEPTH = 32;
const COLLISION_GROUP_LIMIT = 2; // MuJoCo's viewer shows geom groups 0–2.

export async function convertMjcfToUrdf(sourcePath: string, content: string): Promise<MjcfConversion> {
  const io = getCoreIo();
  const diagnostics: StudioDiagnostic[] = [];
  const includedFiles: string[] = [];
  const modelDir = io.dirname(sourcePath);
  const report = (severity: StudioDiagnostic['severity'], code: string, message: string): void => {
    diagnostics.push({ severity, code, message, file: sourcePath });
  };

  const doc = parseXml(content, 'MJCF');
  const root = doc.documentElement;

  // <include file="…"/> is replaced by the children of the included
  // <mujoco> element, recursively. Paths are relative to the main model.
  const expandIncludes = async (element: Element, stack: string[]): Promise<void> => {
    for (const child of directChildren(element)) {
      if (child.tagName !== 'include') {
        await expandIncludes(child, stack);
        continue;
      }
      const file = optionalAttr(child, 'file') ?? '';
      const includePath = io.isAbsolute(file) ? file : io.resolve(modelDir, file);
      if (stack.includes(includePath) || stack.length >= MAX_INCLUDE_DEPTH) {
        report('error', 'mjcf.include', `Include cycle at "${file}"; the include was skipped.`);
        element.removeChild(child);
        continue;
      }
      let included: Document;
      try {
        included = parseXml(await io.readText(includePath), `Included file ${file}`);
      } catch (error) {
        report('error', 'mjcf.include', `Could not include "${file}": ${error instanceof Error ? error.message : String(error)}`);
        element.removeChild(child);
        continue;
      }
      includedFiles.push(includePath);
      const nested = included.documentElement;
      await expandIncludes(nested, [...stack, includePath]);
      for (const node of Array.from(nested.childNodes)) {
        element.insertBefore(doc.importNode(node, true), child);
      }
      element.removeChild(child);
    }
  };
  await expandIncludes(root, [sourcePath]);

  // --- compiler -----------------------------------------------------------
  const compilerAttrs: Attrs = {};
  for (const compiler of directChildren(root, 'compiler')) {
    Object.assign(compilerAttrs, attrsOf(compiler));
  }
  const compiler: Compiler = {
    degrees: (compilerAttrs.angle ?? 'degree') !== 'radian',
    eulerSeq: compilerAttrs.eulerseq ?? 'xyz',
    meshDir: compilerAttrs.meshdir ?? compilerAttrs.assetdir ?? '',
    autoLimits: (compilerAttrs.autolimits ?? 'true') !== 'false'
  };
  const angle = (value: number): number => compiler.degrees ? value * Math.PI / 180 : value;

  // --- defaults -----------------------------------------------------------
  const classes = new Map<string, DefaultSet>();
  const collectDefaults = (element: Element, inherited: DefaultSet): void => {
    const name = optionalAttr(element, 'class') ?? 'main';
    const own: DefaultSet = {};
    for (const [tag, attrs] of Object.entries(inherited)) own[tag] = { ...attrs };
    for (const child of directChildren(element)) {
      if (child.tagName === 'default') continue;
      own[child.tagName] = { ...(own[child.tagName] ?? {}), ...attrsOf(child) };
    }
    classes.set(name, own);
    for (const child of directChildren(element, 'default')) {
      collectDefaults(child, own);
    }
  };
  for (const defaults of directChildren(root, 'default')) {
    collectDefaults(defaults, classes.get('main') ?? {});
  }
  const attribute = (element: Element, name: string, activeClass: string): string | undefined => {
    const value = optionalAttr(element, name);
    if (value !== undefined) return value;
    const className = optionalAttr(element, 'class') ?? activeClass;
    return (classes.get(className) ?? classes.get('main'))?.[element.tagName]?.[name];
  };

  const orientation = (element: Element, activeClass: string): Quat => {
    const get = (name: string): string | undefined => attribute(element, name, activeClass);
    const quat = numbers(get('quat'));
    if (quat && quat.length === 4) return qnormalize([quat[0], quat[1], quat[2], quat[3]]);
    const axisangle = numbers(get('axisangle'));
    if (axisangle && axisangle.length === 4) {
      return axisAngle([axisangle[0], axisangle[1], axisangle[2]], angle(axisangle[3]));
    }
    const euler = numbers(get('euler'));
    if (euler && euler.length === 3) {
      let q: Quat = [1, 0, 0, 0];
      for (let i = 0; i < 3; i += 1) {
        const letter = compiler.eulerSeq[i] ?? 'xyz'[i];
        const axis: Vec3 = letter.toLowerCase() === 'x' ? [1, 0, 0] : letter.toLowerCase() === 'y' ? [0, 1, 0] : [0, 0, 1];
        const step = axisAngle(axis, angle(euler[i]));
        // Lower-case axes rotate with the frame (intrinsic), upper-case
        // about the fixed frame (extrinsic).
        q = letter === letter.toLowerCase() ? qmul(q, step) : qmul(step, q);
      }
      return qnormalize(q);
    }
    const xyaxes = numbers(get('xyaxes'));
    if (xyaxes && xyaxes.length === 6) {
      const x = normalize([xyaxes[0], xyaxes[1], xyaxes[2]]);
      const rawY: Vec3 = [xyaxes[3], xyaxes[4], xyaxes[5]];
      const d = x[0] * rawY[0] + x[1] * rawY[1] + x[2] * rawY[2];
      const y = normalize([rawY[0] - d * x[0], rawY[1] - d * x[1], rawY[2] - d * x[2]]);
      const z = cross(x, y);
      return fromMatrix([[x[0], y[0], z[0]], [x[1], y[1], z[1]], [x[2], y[2], z[2]]]);
    }
    const zaxis = numbers(get('zaxis'));
    if (zaxis && zaxis.length === 3) return fromZAxis([zaxis[0], zaxis[1], zaxis[2]]);
    return IDENTITY.quat;
  };
  const poseOf = (element: Element, activeClass: string): Pose => ({
    pos: vec3(attribute(element, 'pos', activeClass), [0, 0, 0]),
    quat: orientation(element, activeClass)
  });

  // --- assets -------------------------------------------------------------
  const meshes = new Map<string, { file: string; scale?: Vec3 }>();
  const materials = new Map<string, string>();
  for (const assets of directChildren(root, 'asset')) {
    for (const mesh of directChildren(assets, 'mesh')) {
      const file = attribute(mesh, 'file', 'main');
      if (!file) continue; // inline vertex meshes are reported where used
      const name = optionalAttr(mesh, 'name') ?? file.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');
      const meshPath = io.isAbsolute(file) || io.isAbsolute(compiler.meshDir)
        ? io.join(compiler.meshDir, file)
        : [compiler.meshDir, file].filter(Boolean).join('/').replace(/\/{2,}/g, '/');
      const scale = numbers(attribute(mesh, 'scale', 'main'));
      meshes.set(name, { file: meshPath, scale: scale && scale.length === 3 ? [scale[0], scale[1], scale[2]] : undefined });
    }
    for (const material of directChildren(assets, 'material')) {
      const name = optionalAttr(material, 'name');
      const rgba = attribute(material, 'rgba', 'main');
      if (name && rgba) materials.set(name, rgba);
    }
  }

  // --- tree ---------------------------------------------------------------
  const linkXml: string[] = [];
  const jointXml: string[] = [];
  const usedNames = new Set<string>();
  const unique = (base: string): string => {
    let name = base;
    for (let n = 2; usedNames.has(name); n += 1) name = `${base}_${n}`;
    usedNames.add(name);
    return name;
  };
  const approximations = { ball: [] as string[], free: [] as string[], ellipsoid: 0, skipped: new Set<string>() };

  const origin = (pose: Pose): string => {
    const rpy = quatToRpy(pose.quat);
    const fmt = (v: Vec3): string => v.map(n => Number(n.toFixed(9))).join(' ');
    return `<origin xyz="${fmt(pose.pos)}" rpy="${fmt(rpy)}"/>`;
  };

  /** Geometry for one geom in its link frame; capsules expand to three shapes. */
  const geomShapes = (geom: Element, activeClass: string, framePose: Pose): Array<{ pose: Pose; geometry: string }> => {
    const type = attribute(geom, 'type', activeClass) ?? 'sphere';
    const size = numbers(attribute(geom, 'size', activeClass)) ?? [];
    let pose = compose(framePose, poseOf(geom, activeClass));
    let halfLength = size[1] ?? 0;
    const fromto = numbers(attribute(geom, 'fromto', activeClass));
    if (fromto && fromto.length === 6 && (type === 'capsule' || type === 'cylinder')) {
      const a: Vec3 = [fromto[0], fromto[1], fromto[2]];
      const b: Vec3 = [fromto[3], fromto[4], fromto[5]];
      const axis: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
      halfLength = Math.hypot(...axis) / 2;
      pose = compose(framePose, { pos: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2], quat: fromZAxis(axis) });
    }
    const r = size[0] ?? 0;
    switch (type) {
      case 'sphere':
        return [{ pose, geometry: `<sphere radius="${r}"/>` }];
      case 'box':
        return [{ pose, geometry: `<box size="${2 * (size[0] ?? 0)} ${2 * (size[1] ?? 0)} ${2 * (size[2] ?? 0)}"/>` }];
      case 'cylinder':
        return [{ pose, geometry: `<cylinder radius="${r}" length="${2 * halfLength}"/>` }];
      case 'capsule':
        return [
          { pose, geometry: `<cylinder radius="${r}" length="${2 * halfLength}"/>` },
          { pose: compose(pose, { pos: [0, 0, halfLength], quat: IDENTITY.quat }), geometry: `<sphere radius="${r}"/>` },
          { pose: compose(pose, { pos: [0, 0, -halfLength], quat: IDENTITY.quat }), geometry: `<sphere radius="${r}"/>` }
        ];
      case 'ellipsoid':
        approximations.ellipsoid += 1;
        return [{ pose, geometry: `<sphere radius="${Math.max(size[0] ?? 0, size[1] ?? 0, size[2] ?? 0)}"/>` }];
      case 'plane': {
        // Infinite planes (size 0) are floors; the viewer already has a grid.
        if (!(size[0] > 0 && size[1] > 0)) return [];
        return [{ pose, geometry: `<box size="${2 * size[0]} ${2 * size[1]} 0.001"/>` }];
      }
      case 'mesh': {
        const meshName = attribute(geom, 'mesh', activeClass) ?? '';
        const mesh = meshes.get(meshName);
        if (!mesh) {
          approximations.skipped.add(`mesh "${meshName}" (not a file mesh)`);
          return [];
        }
        if (/\.msh$/i.test(mesh.file)) {
          approximations.skipped.add(`mesh "${meshName}" (.msh format)`);
          return [];
        }
        const scale = mesh.scale ? ` scale="${mesh.scale.join(' ')}"` : '';
        return [{ pose, geometry: `<mesh filename="${escapeXmlAttr(mesh.file)}"${scale}/>` }];
      }
      default:
        approximations.skipped.add(`${type} geoms`);
        return [];
    }
  };

  /** Visual, collision and inertial XML for everything directly in `container`
   *  (a body or a frame inside it), in the link frame given by `framePose`. */
  const linkContents = (container: Element, activeClass: string, framePose: Pose, out: string[]): void => {
    for (const child of directChildren(container)) {
      if (child.tagName === 'frame') {
        const frameClass = optionalAttr(child, 'childclass') ?? activeClass;
        linkContents(child, frameClass, compose(framePose, poseOf(child, activeClass)), out);
      } else if (child.tagName === 'geom') {
        const group = Number(attribute(child, 'group', activeClass) ?? 0);
        const contype = Number(attribute(child, 'contype', activeClass) ?? 1);
        const conaffinity = Number(attribute(child, 'conaffinity', activeClass) ?? 1);
        const materialName = attribute(child, 'material', activeClass);
        const rgba = attribute(child, 'rgba', activeClass) ?? (materialName ? materials.get(materialName) : undefined) ?? '0.5 0.5 0.5 1';
        for (const shape of geomShapes(child, activeClass, framePose)) {
          if (group <= COLLISION_GROUP_LIMIT) {
            out.push(`<visual>${origin(shape.pose)}<geometry>${shape.geometry}</geometry><material name="${escapeXmlAttr(materialName ?? `rgba_${rgba.replace(/\s+/g, '_')}`)}"><color rgba="${escapeXmlAttr(rgba)}"/></material></visual>`);
          }
          if (contype !== 0 || conaffinity !== 0) {
            out.push(`<collision>${origin(shape.pose)}<geometry>${shape.geometry}</geometry></collision>`);
          }
        }
      } else if (child.tagName === 'inertial') {
        const mass = Number(optionalAttr(child, 'mass') ?? 0);
        const pose = compose(framePose, poseOf(child, activeClass));
        const diag = numbers(optionalAttr(child, 'diaginertia'));
        const full = numbers(optionalAttr(child, 'fullinertia'));
        const [ixx, iyy, izz, ixy, ixz, iyz] = full && full.length === 6
          ? full
          : [diag?.[0] ?? 0, diag?.[1] ?? 0, diag?.[2] ?? 0, 0, 0, 0];
        out.push(`<inertial>${origin(pose)}<mass value="${mass}"/><inertia ixx="${ixx}" iyy="${iyy}" izz="${izz}" ixy="${ixy}" ixz="${ixz}" iyz="${iyz}"/></inertial>`);
      }
    }
  };

  let bodyCount = 0;
  const addBody = (body: Element, parentLink: string, parentFrame: Pose, inheritedClass: string): void => {
    bodyCount += 1;
    const ownClass = inheritedClass;
    const childClass = optionalAttr(body, 'childclass') ?? inheritedClass;
    const linkName = unique(optionalAttr(body, 'name') ?? `body_${bodyCount}`);
    const bodyPose = compose(parentFrame, poseOf(body, ownClass));

    // Joints are direct children of a body (MuJoCo does not allow them
    // inside <frame>), applied in document order.
    const movable: Array<{ name: string; type: 'revolute' | 'continuous' | 'prismatic'; axis: Vec3; pos: Vec3; range?: [number, number] }> = [];
    for (const joint of directChildren(body).filter(el => el.tagName === 'joint' || el.tagName === 'freejoint')) {
      const type = joint.tagName === 'freejoint' ? 'free' : attribute(joint, 'type', childClass) ?? 'hinge';
      const name = optionalAttr(joint, 'name') ?? `${linkName}_${type}`;
      if (type === 'free') { approximations.free.push(name); continue; }
      if (type === 'ball') { approximations.ball.push(name); continue; }
      if (type !== 'hinge' && type !== 'slide') continue;
      const rangeValues = numbers(attribute(joint, 'range', childClass));
      const limitedAttr = attribute(joint, 'limited', childClass) ?? 'auto';
      const limited = limitedAttr === 'true' || (limitedAttr === 'auto' && compiler.autoLimits && !!rangeValues);
      const range: [number, number] | undefined = limited && rangeValues && rangeValues.length >= 2
        ? (type === 'hinge' ? [angle(rangeValues[0]), angle(rangeValues[1])] : [rangeValues[0], rangeValues[1]])
        : undefined;
      movable.push({
        name,
        type: type === 'slide' ? 'prismatic' : range ? 'revolute' : 'continuous',
        axis: normalize(vec3(attribute(joint, 'axis', childClass), [0, 0, 1])),
        pos: vec3(attribute(joint, 'pos', childClass), [0, 0, 0]),
        range
      });
    }

    // The final link's frame sits at the last joint's anchor (body
    // orientation), so everything in the body is shifted by -anchor.
    let previousLink = parentLink;
    let previousAnchor: Vec3 = [0, 0, 0];
    movable.forEach((joint, index) => {
      const isLast = index === movable.length - 1;
      const child = isLast ? linkName : unique(`${linkName}__${joint.name}`);
      if (!isLast) linkXml.push(`<link name="${escapeXmlAttr(child)}"/>`);
      const step: Vec3 = [joint.pos[0] - previousAnchor[0], joint.pos[1] - previousAnchor[1], joint.pos[2] - previousAnchor[2]];
      const jointOrigin = index === 0 ? compose(bodyPose, { pos: joint.pos, quat: IDENTITY.quat }) : { pos: step, quat: IDENTITY.quat };
      const limit = joint.range ? `<limit lower="${joint.range[0]}" upper="${joint.range[1]}"/>` : '';
      jointXml.push(`<joint name="${escapeXmlAttr(unique(joint.name))}" type="${joint.type}"><parent link="${escapeXmlAttr(previousLink)}"/><child link="${escapeXmlAttr(child)}"/>${origin(jointOrigin)}<axis xyz="${joint.axis.join(' ')}"/>${limit}</joint>`);
      previousLink = child;
      previousAnchor = joint.pos;
    });
    if (movable.length === 0) {
      jointXml.push(`<joint name="${escapeXmlAttr(unique(`${linkName}_fixed`))}" type="fixed"><parent link="${escapeXmlAttr(parentLink)}"/><child link="${escapeXmlAttr(linkName)}"/>${origin(bodyPose)}</joint>`);
    }
    const linkFrame: Pose = { pos: [-previousAnchor[0], -previousAnchor[1], -previousAnchor[2]], quat: IDENTITY.quat };

    const contents: string[] = [];
    linkContents(body, childClass, linkFrame, contents);
    linkXml.push(`<link name="${escapeXmlAttr(linkName)}">${contents.join('')}</link>`);

    addChildBodies(body, linkName, linkFrame, childClass);
  };

  const addChildBodies = (container: Element, parentLink: string, framePose: Pose, activeClass: string): void => {
    for (const child of directChildren(container)) {
      if (child.tagName === 'body') {
        addBody(child, parentLink, framePose, activeClass);
      } else if (child.tagName === 'frame') {
        addChildBodies(child, parentLink, compose(framePose, poseOf(child, activeClass)), optionalAttr(child, 'childclass') ?? activeClass);
      }
    }
  };

  const worldLink = unique('world');
  const worldContents: string[] = [];
  for (const worldbody of directChildren(root, 'worldbody')) {
    linkContents(worldbody, 'main', IDENTITY, worldContents);
  }
  linkXml.push(`<link name="${escapeXmlAttr(worldLink)}">${worldContents.join('')}</link>`);
  for (const worldbody of directChildren(root, 'worldbody')) {
    addChildBodies(worldbody, worldLink, IDENTITY, 'main');
  }

  // --- report what URDF cannot represent ------------------------------------
  const list = (names: string[]): string => names.slice(0, 5).join(', ') + (names.length > 5 ? ` and ${names.length - 5} more` : '');
  if (approximations.free.length > 0) {
    report('info', 'mjcf.freeJoint', `Free joint${approximations.free.length === 1 ? '' : 's'} ${list(approximations.free)} shown fixed at the initial pose.`);
  }
  if (approximations.ball.length > 0) {
    report('info', 'mjcf.ballJoint', `Ball joint${approximations.ball.length === 1 ? '' : 's'} ${list(approximations.ball)} shown fixed: URDF has no ball joint.`);
  }
  if (approximations.ellipsoid > 0) {
    report('info', 'mjcf.ellipsoid', `${approximations.ellipsoid} ellipsoid geom${approximations.ellipsoid === 1 ? '' : 's'} drawn as spheres of the largest radius.`);
  }
  if (approximations.skipped.size > 0) {
    report('info', 'mjcf.unsupported', `Not drawn: ${[...approximations.skipped].join(', ')}.`);
  }

  const modelName = optionalAttr(root, 'model') ?? io.basename(sourcePath).replace(/\.[^.]+$/, '');
  const urdf = [
    '<?xml version="1.0"?>',
    `<!-- Converted from MJCF ${escapeXmlAttr(io.basename(sourcePath))} by URDF Studio for viewing. -->`,
    `<robot name="${escapeXmlAttr(modelName)}">`,
    ...linkXml.map(line => `  ${line}`),
    ...jointXml.map(line => `  ${line}`),
    '</robot>',
    ''
  ].join('\n');
  return { urdf, diagnostics, includedFiles };
}

import type { RobotMetadata } from './types';
import { inertiaEigenvalues } from './inertia';

const BOM_COLUMNS = [
  'link',
  'parent_joint',
  'parent_joint_type',
  'mass_kg',
  'com_x',
  'com_y',
  'com_z',
  'ixx',
  'iyy',
  'izz',
  'ixy',
  'ixz',
  'iyz',
  'inertia_eig_1',
  'inertia_eig_2',
  'inertia_eig_3',
  'visual_meshes',
  'collision_meshes',
  'missing_meshes'
] as const;

export function buildBomCsv(metadata: RobotMetadata): string {
  const meshesByLink = new Map<string, { visual: string[]; collision: string[]; missing: string[] }>();
  for (const mesh of metadata.meshes) {
    let entry = meshesByLink.get(mesh.link);
    if (!entry) {
      entry = { visual: [], collision: [], missing: [] };
      meshesByLink.set(mesh.link, entry);
    }
    const label = mesh.resolvedPath ?? mesh.filename;
    if (mesh.kind === 'visual') {
      entry.visual.push(label);
    } else {
      entry.collision.push(label);
    }
    if (!mesh.exists) {
      entry.missing.push(label);
    }
  }

  const rows = [BOM_COLUMNS.join(',')];
  const linkNames = Object.keys(metadata.links).sort();
  for (const linkName of linkNames) {
    const link = metadata.links[linkName];
    const parentJoint = link.parentJoint ? metadata.joints[link.parentJoint] : undefined;
    const inertial = link.inertial;
    const eig = inertial ? inertiaEigenvalues(inertial) : undefined;
    const meshes = meshesByLink.get(linkName);
    const cells = [
      linkName,
      parentJoint?.name ?? '',
      parentJoint?.type ?? '',
      inertial ? num(inertial.mass) : '',
      inertial ? num(inertial.origin[0]) : '',
      inertial ? num(inertial.origin[1]) : '',
      inertial ? num(inertial.origin[2]) : '',
      inertial ? num(inertial.ixx) : '',
      inertial ? num(inertial.iyy) : '',
      inertial ? num(inertial.izz) : '',
      inertial ? num(inertial.ixy) : '',
      inertial ? num(inertial.ixz) : '',
      inertial ? num(inertial.iyz) : '',
      eig ? num(eig[0]) : '',
      eig ? num(eig[1]) : '',
      eig ? num(eig[2]) : '',
      meshes ? meshes.visual.join('; ') : '',
      meshes ? meshes.collision.join('; ') : '',
      meshes ? meshes.missing.join('; ') : ''
    ];
    rows.push(cells.map(escapeCsv).join(','));
  }
  return rows.join('\n') + '\n';
}

function num(value: number): string {
  if (!Number.isFinite(value)) {
    return '';
  }
  // Six significant digits is enough for kg / m / kg·m² without scientific
  // notation noise for everyday robots.
  return Number(value.toFixed(6)).toString();
}

function escapeCsv(value: string): string {
  if (/[",\n\r]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

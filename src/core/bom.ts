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
  if (value === 0) {
    return '0';
  }
  // Six *significant* digits — not six decimal places. toFixed(6) would round
  // tiny inertias like 2.5e-7 down to "0"; toPrecision(6) preserves them.
  // Number(...) then strips trailing-zero / scientific-notation noise where
  // it can (e.g. "1.25000" -> "1.25") while still falling back to exponential
  // form for genuinely tiny/huge magnitudes.
  return Number(value.toPrecision(6)).toString();
}

function escapeCsv(value: string): string {
  // CSV formula injection: a cell beginning with = + - @ (optionally after a
  // leading space/tab) is executed as a formula by Excel / Google Sheets.
  // Neutralize by prefixing a single quote, then apply the usual quoting.
  // A leading `-` is also legal for negative numbers, so don't quote-guard a
  // cell that is a plain numeric value (e.g. "-1.25") — only genuine text.
  let cell = value;
  if (/^[\s]*[=+\-@]/.test(cell) && !/^-?\d/.test(cell)) {
    cell = `'${cell}`;
  }
  if (/[",\n\r]/.test(cell)) {
    return `"${cell.replace(/"/g, '""')}"`;
  }
  return cell;
}

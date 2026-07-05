import type { InertialInfo } from './types';

export interface InertiaTensor {
  ixx: number;
  ixy: number;
  ixz: number;
  iyy: number;
  iyz: number;
  izz: number;
}

interface JacobiResult {
  /** Eigenvalues in the natural (unsorted) Jacobi diagonal order. */
  values: [number, number, number];
  /** Eigenvectors as columns: vectors[k] is the unit eigenvector for values[k]. */
  vectors: [[number, number, number], [number, number, number], [number, number, number]];
}

// Symmetric 3x3 Jacobi rotation that also accumulates the eigenvector basis.
// The previous implementation discarded the rotation matrix, which is why the
// ellipsoid visualisation could not be oriented along the principal axes.
function jacobiEigen(tensor: InertiaTensor): JacobiResult {
  const m = [
    [tensor.ixx, tensor.ixy, tensor.ixz],
    [tensor.ixy, tensor.iyy, tensor.iyz],
    [tensor.ixz, tensor.iyz, tensor.izz]
  ];
  // v accumulates the product of Jacobi rotations; its columns are the
  // eigenvectors once m has been diagonalised.
  const v = [
    [1, 0, 0],
    [0, 1, 0],
    [0, 0, 1]
  ];
  for (let iter = 0; iter < 64; iter += 1) {
    let p = 0;
    let q = 1;
    let max = Math.abs(m[0][1]);
    for (let i = 0; i < 3; i += 1) {
      for (let j = i + 1; j < 3; j += 1) {
        if (Math.abs(m[i][j]) > max) {
          max = Math.abs(m[i][j]);
          p = i;
          q = j;
        }
      }
    }
    if (max < 1e-12) {
      break;
    }
    const theta = (m[q][q] - m[p][p]) / (2 * m[p][q]);
    const t = theta >= 0
      ? 1 / (theta + Math.sqrt(1 + theta * theta))
      : 1 / (theta - Math.sqrt(1 + theta * theta));
    const c = 1 / Math.sqrt(1 + t * t);
    const s = t * c;
    const mpp = m[p][p];
    const mqq = m[q][q];
    const mpq = m[p][q];
    m[p][p] = mpp - t * mpq;
    m[q][q] = mqq + t * mpq;
    m[p][q] = 0;
    m[q][p] = 0;
    for (let r = 0; r < 3; r += 1) {
      if (r !== p && r !== q) {
        const mrp = m[r][p];
        const mrq = m[r][q];
        m[r][p] = c * mrp - s * mrq;
        m[p][r] = m[r][p];
        m[r][q] = s * mrp + c * mrq;
        m[q][r] = m[r][q];
      }
    }
    // Rotate the eigenvector basis with the same (c, s) so its columns track
    // the diagonalisation.
    for (let r = 0; r < 3; r += 1) {
      const vrp = v[r][p];
      const vrq = v[r][q];
      v[r][p] = c * vrp - s * vrq;
      v[r][q] = s * vrp + c * vrq;
    }
  }
  return {
    values: [m[0][0], m[1][1], m[2][2]],
    vectors: [
      [v[0][0], v[1][0], v[2][0]],
      [v[0][1], v[1][1], v[2][1]],
      [v[0][2], v[1][2], v[2][2]]
    ]
  };
}

export function inertiaEigenvalues(tensor: InertiaTensor): [number, number, number] {
  // Returns eigenvalues sorted descending (callers that only need magnitudes:
  // positive-definiteness checks, BOM display).
  const values = jacobiEigen(tensor).values;
  values.sort((a, b) => b - a);
  return values;
}

export interface InertiaEllipsoid {
  /** Semi-axes along the principal axes, matching `rotation`'s columns. */
  semiAxes: [number, number, number];
  /** Row-major 3x3 rotation whose columns are the principal axes (right-handed). */
  rotation: number[];
}

const IDENTITY_3X3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

// Full ellipsoid description: semi-axes AND the principal-axis orientation.
// The semi-axes correspond one-to-one with the eigenvectors (no sorting), so
// the caller can build a correctly oriented ellipsoid for non-diagonal tensors.
export function inertiaEllipsoid(inertial: InertialInfo): InertiaEllipsoid {
  if (inertial.mass <= 0) {
    return { semiAxes: [0, 0, 0], rotation: [...IDENTITY_3X3] };
  }
  const { values, vectors } = jacobiEigen(inertial);
  // For a uniform-density solid ellipsoid with semi-axes (a, b, c) and mass m:
  //   I_1 = (m/5)(b^2 + c^2),  I_2 = (m/5)(a^2 + c^2),  I_3 = (m/5)(a^2 + b^2)
  // Solving gives  a^2 = (5/2m)(I_2 + I_3 - I_1), etc., where (I_1,I_2,I_3) are
  // the principal moments along the eigenvectors.
  const [l1, l2, l3] = values;
  const factor = 5 / (2 * inertial.mass);
  const semiAxes: [number, number, number] = [
    Math.sqrt(Math.max(0, factor * (l2 + l3 - l1))),
    Math.sqrt(Math.max(0, factor * (l1 + l3 - l2))),
    Math.sqrt(Math.max(0, factor * (l1 + l2 - l3)))
  ];
  // Row-major matrix whose columns are the eigenvectors: element(row, col) =
  // vectors[col][row].
  const rotation = [
    vectors[0][0], vectors[1][0], vectors[2][0],
    vectors[0][1], vectors[1][1], vectors[2][1],
    vectors[0][2], vectors[1][2], vectors[2][2]
  ];
  // Guarantee a right-handed basis (det = +1) so the ellipsoid is not mirrored.
  if (determinant3(rotation) < 0) {
    rotation[2] = -rotation[2];
    rotation[5] = -rotation[5];
    rotation[8] = -rotation[8];
  }
  return { semiAxes, rotation };
}

function determinant3(m: number[]): number {
  return (
    m[0] * (m[4] * m[8] - m[5] * m[7]) -
    m[1] * (m[3] * m[8] - m[5] * m[6]) +
    m[2] * (m[3] * m[7] - m[4] * m[6])
  );
}

export function ellipsoidSemiAxes(inertial: InertialInfo): [number, number, number] {
  return inertiaEllipsoid(inertial).semiAxes;
}

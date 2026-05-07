import type { InertialInfo } from './types';

export interface InertiaTensor {
  ixx: number;
  ixy: number;
  ixz: number;
  iyy: number;
  iyz: number;
  izz: number;
}

export function inertiaEigenvalues(tensor: InertiaTensor): [number, number, number] {
  // Symmetric 3x3 Jacobi rotation. Returns sorted descending.
  const m = [
    [tensor.ixx, tensor.ixy, tensor.ixz],
    [tensor.ixy, tensor.iyy, tensor.iyz],
    [tensor.ixz, tensor.iyz, tensor.izz]
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
  }
  const values: [number, number, number] = [m[0][0], m[1][1], m[2][2]];
  values.sort((a, b) => b - a);
  return values;
}

export function ellipsoidSemiAxes(inertial: InertialInfo): [number, number, number] {
  if (inertial.mass <= 0) {
    return [0, 0, 0];
  }
  const eigenvalues = inertiaEigenvalues(inertial);
  // For a uniform-density solid ellipsoid with semi-axes (a, b, c) and mass m:
  //   I_x = (m/5)(b^2 + c^2),  I_y = (m/5)(a^2 + c^2),  I_z = (m/5)(a^2 + b^2)
  // Solving gives  a^2 = (5/2m)(I_y + I_z - I_x), etc.
  const [l1, l2, l3] = eigenvalues;
  const factor = 5 / (2 * inertial.mass);
  const a2 = Math.max(0, factor * (l2 + l3 - l1));
  const b2 = Math.max(0, factor * (l1 + l3 - l2));
  const c2 = Math.max(0, factor * (l1 + l2 - l3));
  return [Math.sqrt(a2), Math.sqrt(b2), Math.sqrt(c2)];
}

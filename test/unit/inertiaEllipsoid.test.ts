import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inertiaEllipsoid } from '../../src/core/inertia';

// =============================================================================
// inertiaEllipsoid — semi-axes AND principal-axis orientation.
// Regression coverage for the bug where the ellipsoid was drawn along the
// wrong axis (eigenvalues were sorted, eigenvectors discarded).
// =============================================================================

test('a rod along X stretches the ellipsoid along X (axis 0), not Z', () => {
  // Thin rod about the X axis: I_xx ≈ 0, I_yy = I_zz = I. The long semi-axis
  // must land on the first (X) principal axis with a near-identity rotation.
  const { semiAxes, rotation } = inertiaEllipsoid({
    mass: 1,
    origin: [0, 0, 0],
    rotation: [0, 0, 0],
    ixx: 1e-5, iyy: 0.01, izz: 0.01, ixy: 0, ixz: 0, iyz: 0
  });
  const maxIndex = semiAxes.indexOf(Math.max(...semiAxes));
  assert.equal(maxIndex, 0, `expected long axis on X, got semiAxes=${semiAxes}`);
  assert.ok(semiAxes[0] > semiAxes[1] * 10, 'X semi-axis should dominate');
  // Diagonal tensor ⇒ principal axes are the coordinate axes (identity).
  const identity = [1, 0, 0, 0, 1, 0, 0, 0, 1];
  for (let i = 0; i < 9; i += 1) {
    assert.ok(Math.abs(Math.abs(rotation[i]) - identity[i]) < 1e-6, `rotation[${i}]=${rotation[i]}`);
  }
});

test('the returned rotation diagonalizes a non-diagonal tensor', () => {
  // Couple ixx/iyy so the principal axes are rotated 45° in the XY plane.
  const tensor = { ixx: 2, iyy: 2, izz: 5, ixy: 1, ixz: 0, iyz: 0 };
  const { rotation } = inertiaEllipsoid({
    mass: 2, origin: [0, 0, 0], rotation: [0, 0, 0], ...tensor
  });
  // R is row-major with columns = eigenvectors. Verify Rᵀ·M·R is diagonal.
  const M = [
    [tensor.ixx, tensor.ixy, tensor.ixz],
    [tensor.ixy, tensor.iyy, tensor.iyz],
    [tensor.ixz, tensor.iyz, tensor.izz]
  ];
  const col = (j: number) => [rotation[j], rotation[3 + j], rotation[6 + j]];
  const mul = (v: number[]) => [
    M[0][0] * v[0] + M[0][1] * v[1] + M[0][2] * v[2],
    M[1][0] * v[0] + M[1][1] * v[1] + M[1][2] * v[2],
    M[2][0] * v[0] + M[2][1] * v[1] + M[2][2] * v[2]
  ];
  const dot = (a: number[], b: number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  // Off-diagonal entries of Rᵀ M R must vanish.
  for (let i = 0; i < 3; i += 1) {
    for (let j = 0; j < 3; j += 1) {
      if (i === j) continue;
      assert.ok(Math.abs(dot(col(i), mul(col(j)))) < 1e-6, `off-diagonal (${i},${j}) not zero`);
    }
  }
});

test('right-handed basis: determinant of the rotation is +1', () => {
  const { rotation: r } = inertiaEllipsoid({
    mass: 1, origin: [0, 0, 0], rotation: [0, 0, 0],
    ixx: 3, iyy: 2, izz: 1, ixy: 0.4, ixz: 0.2, iyz: 0.1
  });
  const det =
    r[0] * (r[4] * r[8] - r[5] * r[7]) -
    r[1] * (r[3] * r[8] - r[5] * r[6]) +
    r[2] * (r[3] * r[7] - r[4] * r[6]);
  assert.ok(Math.abs(det - 1) < 1e-6, `det=${det}`);
});

---
title: Frames & inertia overlays
order: 30
---

# Frames & inertia overlays

Two visualisation layers live in the subtoolbar (below the main toolbar).

## TF frames

A per-link XYZ axes helper. The `Frames` select offers three modes:

| Mode | Effect |
|---|---|
| `off` | No axes (default). |
| `selected` | Axes are drawn only on the currently selected link. |
| `all` | Axes are drawn on every link. |

The helper is sized relative to the robot's bounding radius so it remains
visible on both tiny grippers and full humanoid arms.

Useful for:

- Validating that joint origins point where you think they do.
- Spotting accidental rotations between parent and child frames.
- Authoring/debugging a custom end-effector mount.

## Inertia

Check **Inertia** in the subtoolbar to overlay:

- An inertia ellipsoid on each link with a valid `<inertial>` block. The
  ellipsoid axes are derived from the eigenvalues of the inertia tensor
  (`I = R Λ Rᵀ`) and oriented along the eigenvectors. A larger ellipsoid
  means more rotational inertia along that axis.
- A small marker at each link's center of mass.
- A larger marker at the robot's **total** CoM, weighted by mass.

The Inspector tab still shows the raw tensor components, mass, and origin
of whichever link you have selected — see
[Inspector & link tree](./inspector.html).

## Diagnostics that interact with this layer

If a link's inertia tensor is missing, has non-positive mass, or has a
non-positive-definite tensor, the **Checks** panel surfaces it. The
ellipsoid for such a link is skipped or rendered with a warning color so
you can spot bad data visually. See
[Diagnostics](./diagnostics.html#inertial).

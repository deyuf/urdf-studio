---
title: Frames, labels and inertia
order: 30
summary: Show link coordinate frames, joint and link names, centres of mass and inertia ellipsoids in the 3D view.
---

# Frames, labels and inertia

These overlays live in the **Display** menu of the 3D view. They help you
check that a model is built the way you think it is.

## Coordinate frames

**Frames** draws a small X/Y/Z axis (red/green/blue) at each link's origin:

| Setting | Draws frames on |
|---|---|
| off | Nothing (default) |
| selected | The selected link only |
| all | Every link |

Use it to check that joint origins sit where they should and that axes
point the right way — for example, that a tool frame's Z points out of the
flange. **selected** is the least cluttered: click a link, and its frame
appears.

## Labels

**Labels** writes names into the 3D view: joints, links, or both. Useful on
an unfamiliar robot, or to find which link is which when names are long.

## Centre of mass and inertia

**Inertia** shows how mass is distributed:

- A marker at each link's centre of mass.
- An ellipsoid around it, shaped by the link's inertia. A long ellipsoid
  means the link is harder to rotate around its short axes.
- A larger marker at the centre of mass of the whole robot.

Links without an `<inertial>` block are skipped. If an ellipsoid is huge,
tiny, or far from its link, the inertia values are probably wrong —
[Checks](./diagnostics.html) flags the clearest cases, such as zero mass or
an impossible inertia tensor.

For the numbers themselves, select the link and open the
[Inspector](./inspector.html).

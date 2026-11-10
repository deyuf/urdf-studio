---
title: Visual and collision geometry
order: 20
summary: Switch between visual and collision geometry, overlay both, and highlight links whose collision shapes overlap.
---

# Visual and collision geometry

Every URDF link can have two kinds of geometry: `<visual>` (what you see)
and `<collision>` (what physics engines and planners use). They are often
different meshes, and mistakes in the collision layer are easy to miss
because most tools only show the visual one.

## Switch layers

Use the **Visual** menu in the top-left bar of the 3D view:

| Choice | Shows |
|---|---|
| Visual | Visual geometry only (default) |
| Collision | Collision geometry only |
| Both | Both, with collision shapes drawn see-through over the visual meshes |

Collision geometry is loaded the first time you ask for it, so the first
switch takes a moment. Your pose and camera are kept.

**Both** is the quickest way to check that collision shapes cover the
visual model — look for parts sticking out, offsets, or shapes at the
origin that were meant to be moved.

To start every robot in collision view, change **Default render mode** in
[settings](./settings.html).

## Self-collision

Turn on **Display → Self-collision** to highlight links whose collision
shapes overlap in the current pose. Overlapping links turn red, and a
caption in the corner of the view counts the pairs.

The check updates as you move joints, so you can drag a slider and watch
where the arm starts hitting itself. Links joined directly to each other
are not reported: they usually touch by design.

To turn this into an SRDF `disable_collisions` list for MoveIt, see
[Collision pairs](./tools.html#collision-pairs).

## Wireframe

**Display → Wire** draws every mesh as a wireframe in any layer. It helps
when a collision mesh is far heavier than it should be, or to see a part
hidden inside another.

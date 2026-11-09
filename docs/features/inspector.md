---
title: Inspect a link
order: 50
summary: Browse the link tree, select a link in 3D or in the tree, and read its parent joint, limits, mass, centre of mass and mesh files.
---

# Inspect a link

## Select a link

Either:

- Click the part in the 3D view, or
- Open the **Links** tab and click the link's name.

The selected link gets a yellow box around it, and the **Inspector** tab
opens with its details. Click empty space in the 3D view to clear the
selection.

## The Links tab

The **Links** tab shows the robot as a tree: each link sits under the link
it is attached to. Hover a row to see the joint that connects it to its
parent. The selected link is highlighted.

The tree is a quick structural check. A link that appears at the top level
when it shouldn't usually means a joint names the wrong parent — Checks
reports it as `R-001` or `R-003`.

## What the Inspector shows

| Field | Meaning |
|---|---|
| Link | The link's name |
| Parent | The joint that attaches this link to its parent (`none` for the root) |
| Type | That joint's type: `revolute`, `prismatic`, `fixed`… or `root` |
| Axis | The joint axis, in the joint's frame |
| Limit | Lower and upper limit, in radians or metres |
| Mimic | The joint it follows, as `joint × multiplier + offset`, or `none` |
| Children | Joints that attach other links to this one |
| Mass | From `<inertial><mass>`, or `n/a` if the link has no inertial |
| CoM | Centre of mass, from `<inertial><origin xyz>` |
| Meshes | Each visual and collision mesh file, marked **missing** if it can't be found |

## When a mesh is missing

The Inspector still shows the path written in the URDF, and the part is
left out of the 3D view. The usual causes are covered in
[Troubleshooting](../help/#meshes-are-missing).

## Jump to the source

When a link is selected, the **Source** tab highlights the line where it
is declared. In VS Code, the text editor jumps there too if the file is
open.

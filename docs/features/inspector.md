---
title: Inspector & link tree
order: 50
---

# Inspector & link tree

The **Links** tab shows the full kinematic tree; the **Inspector** tab
shows details for whichever link is currently selected.

## Selecting a link

A link gets selected by:

- Clicking it in the **Links** tree.
- Clicking the corresponding mesh in the 3D viewport.

The selection turns the **Inspector** tab into the active tab and draws a
tight yellow bounding box around the link's own visual geometry (not its
children — the box is local to the link transform). Click on empty space
to deselect.

## Links panel

The kinematic tree is rendered as nested rows:

- The root link is at the top.
- Each child link is indented under its parent joint.
- Clicking a row selects the link.
- A small ▸ / ▾ caret collapses subtrees.

If the URDF analyzer detected multiple root links, all of them appear at
the top and a warning is surfaced in the **Checks** panel.

## Inspector — what's shown

For the selected link:

| Field | Meaning |
|---|---|
| **Parent joint** | Joint connecting this link to its parent, with type, axis, and limits. Empty for root links. |
| **Child joints** | List of outgoing joints (joint name → child link). |
| **Mass** | From `<inertial><mass value=…/>`. |
| **Center of mass** | From `<inertial><origin xyz=…/>`. |
| **Inertia tensor** | The full 3×3 from `<inertia ixx=… iyy=… izz=… …/>`. |
| **Inertia eigenvalues** | Principal inertia, sorted descending. Used by the inertia ellipsoid overlay. |
| **Visual meshes** | Resolved absolute paths of every `<visual><mesh filename=…/>` reference on this link. |
| **Collision meshes** | Same for `<collision>`. |
| **Diagnostics** | Any link-scoped warning/error from the analyzer. |

## How mesh paths resolve

- `package://pkg/...` → looked up in the discovered package map.
- `file://...` → used verbatim.
- Other absolute paths → passed through.
- Relative paths → resolved against the URDF's directory.

If a referenced mesh does not exist on disk, the Inspector still shows the
declared path, and a `mesh.missing` diagnostic appears in the **Checks**
panel.

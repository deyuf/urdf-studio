# Features

## Viewport

- Orbit / pan / zoom via OrbitControls.
- Preset cameras: **Front**, **Right**, **Top**, **Iso**, plus one-click **Fit**.
- Configurable up axis (`+X`, `+Y`, `+Z`).

## Joints

Every movable joint gets a slider and a numeric input, honoring `<limit>` ranges:

- `revolute`, `continuous`, `prismatic`, `floating`, `planar` types supported.
- `<mimic>` joints follow their master automatically (the URDF loader's own limit is bypassed so propagation isn't clamped).
- Toggle **Ignore limits** to drive a joint past its declared range without editing the URDF.
- Search box filters joints by name; **Only modified** filters to joints whose value differs from the default.

## Render modes

| Mode | Effect |
| --- | --- |
| `Visual` | Render `<visual>` meshes only. |
| `Collision` | Render `<collision>` meshes only (primitives and explicit meshes). |
| `Both` | Overlay both, with collision visually distinguished. |

Switching to a mode that needs collision geometry transparently reloads it. The wireframe toggle applies to every mesh, regardless of mode.

## TF frames & inertia

- **Frames: selected** draws an XYZ axes helper on the currently selected link.
- **Frames: all** does it for every link — useful for tracing the kinematic chain visually.
- **Inertia** draws the inertia ellipsoid (sized from the eigenvalues of the inertia tensor) and a marker at the link's center of mass, plus a marker at the total CoM.

## Checks panel

Surfaces every diagnostic emitted by the analyzer:

- xacro expansion errors / skipped expressions
- Duplicate or unnamed links / joints
- Joints referencing missing parents / children
- Multiple parent joints for the same link
- Cycles in the kinematic tree
- Movable joints missing `<limit>` bounds
- Inverted `lower > upper` limits
- `mimic` referencing unknown joints
- Inertials with non-positive mass or non-positive-definite tensors
- Unknown ROS packages, missing meshes, package-less `package://` URIs

## Inspector

Clicking a link in the 3D viewport or the link tree opens its inspector tab:

- Parent and child joints (with type, axis, limits)
- Mass and center-of-mass origin
- Inertia tensor components
- Visual and collision mesh paths
- A tight bounding box highlight in the viewport for that link only

## Tools

The Tools tab hosts compute-heavy actions:

- **Sample Reachability** — Monte-Carlo samples joint configurations, plots the achievable end-effector positions as a point cloud. Useful for visualizing arm workspace.
- **Find self-collision pairs** — Random pose sampling to identify link pairs that never collide; offers to write them as `<disable_collisions>` entries into your SRDF (downloaded in the web app, written in place in VS Code).

## Bookmarks

- **Save As…** stores the current pose + camera under a named bookmark.
- Apply via the dropdown in the toolbar.
- Stored in `localStorage` (web) or the workspace state (VS Code), keyed per-robot.

## Diagnostics integration (VS Code)

In the VS Code build, all diagnostics show up in the Problems panel and live-update as you edit the URDF. The xacro analysis is best-effort here — full expansion only runs when the preview opens.

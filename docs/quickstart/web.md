---
title: Web app
order: 1
---

# Quickstart — Web app

The browser build runs entirely client-side. File bytes never touch a
server; the page asks for read access to a folder you choose and resolves
`package://` URIs against it.

## 1. Open the deployed URL

Reference deployment: <https://urdf.deyuf.org>

Any Chromium-based browser (Chrome, Edge, Brave, Arc, Opera) supports the
File System Access API and gets the full experience. Safari and mobile
browsers fall back to a `webkitdirectory` file picker.

The first visit shows a 4-step onboarding tour. Press **Esc** or click
*Skip* to dismiss; the **?** button in the topbar re-opens it.

## 2. Open a folder

Click **Open Folder** and pick the root of a ROS package or workspace.
The browser scans for:

- `package.xml` (so `package://` URIs resolve)
- `.urdf`, `.urdf.xacro`, `.xacro` (robot files)
- `.stl`, `.dae`, `.obj`, `.gltf`, `.glb` (meshes)
- `.yaml`, `.yml` (xacro `load_yaml` inputs — pre-cached for sync access)
- `.srdf` (semantic descriptions)

The scan yields a flat path index used for everything else. Folders like
`.git`, `node_modules`, `build`, `install`, `log` are skipped.

## 3. Pick a robot

The dropdown lists every URDF/xacro file in the folder. If there is
exactly one, it auto-loads.

```
franka_description ▾
  /franka_description/robots/fr3/fr3.urdf.xacro
  /franka_description/robots/fer/fer.urdf.xacro
  /franka_description/robots/fp3/fp3.urdf.xacro
  ...
```

The status line below the topbar shows progress while xacro expands and
meshes load. When the robot pops into the viewport, link / joint / movable
counts appear briefly.

## 4. Drive and inspect

Right-side panel tabs:

- **Joints** — sliders for every movable joint, search box, filter to
  modified joints only.
- **Inspector** — selected link details (parent/child joints, mass, CoM,
  inertia tensor, mesh paths).
- **Checks** — diagnostics from the parser and analyzer.
- **Links** — kinematic tree.
- **Tools** — reachability sampling, never-colliding pair detection.

See [Features](../features/) for the full reference.

## 5. Save your work

| Action | Result |
|---|---|
| **Save Pose** | Joint values + camera snapshot stored in `localStorage`, keyed by `<folder>:<file-path>`. Restored next time you open the same robot. |
| **Save As…** | Names the pose and adds it to the bookmark dropdown. |
| **Export Pose** | Downloads a JSON file with pose + camera + source path. |
| **Capture Screenshot** | Downloads a PNG of the current viewport. |

## Fallbacks and limits

- **Safari / iOS / Firefox without secure context** — `showDirectoryPicker`
  is unavailable. The **Pick Files** button uses `webkitdirectory` instead;
  works but reads all file metadata into memory up-front, so cold start is
  slower for large packages.
- **HTTPS required** — the File System Access API only works on secure
  origins. Loopback (`127.0.0.1`) counts as secure for dev.
- **Persistence** — directory handles are not persisted across reloads
  (yet). You re-pick the folder each session. Bookmarks and pose are kept.

---
title: Supported files and browsers
order: 30
summary: File types, xacro features, mesh formats and browsers supported by URDF Studio.
---

# Supported files and browsers

## Robot descriptions

| File | Notes |
|---|---|
| `.urdf` | Plain URDF |
| `.urdf.xacro`, `.xacro` | Expanded by URDF Studio — no ROS installation needed |
| `.srdf` | Planning groups, named states, `disable_collisions` |
| `initial_positions.yaml` | Read as a named state |
| `.xml` with a `<mujoco>` root, `.mjcf` | MuJoCo MJCF, read-only — see [View MuJoCo models](../features/mjcf.html) |

### Xacro support

- `xacro:include`, `xacro:macro` (including block and `*` parameters),
  `xacro:property`, `xacro:arg`, `xacro:if` / `xacro:unless`
- `$(find pkg)`, `$(arg name)`
- `${…}` expressions, including Python-style conditionals (`a if c else
  b`), `**` and slicing
- `load_yaml` — the YAML files must be inside the opened folder

If an expression can't be evaluated, it is skipped with a warning and the
rest of the file still loads.

## Meshes

STL, COLLADA (`.dae`), OBJ, glTF (`.gltf`) and GLB. Textures and other
files referenced by `.dae` and `.gltf` meshes are loaded from the same
folder.

Primitive shapes — `<box>`, `<cylinder>`, `<sphere>` — are drawn directly.

## Paths

| Path in the URDF | Resolved against |
|---|---|
| `package://name/…` | The folder containing `name`'s `package.xml`. If none is found, parent folders of the robot file are searched |
| `file:///…` or an absolute path | Used as given (VS Code only — the browser can only see the opened folder) |
| Relative path | The robot file's folder |
| `http://…`, `https://…` | Not supported; download the mesh into the package |

## Browser support

The browser version needs WebGL 2.

| Browser | Open folder & drag-drop | Pick files | Reopen last folder |
|---|---|---|---|
| Chrome, Edge, Brave, Arc, Opera (114+) | Yes | Yes | Yes |
| Firefox (115+) | — | Yes | — |
| Safari (17+) | — | Yes | — |

Folder access only works on a secure (`https://`) page, which
[urdf.deyuf.org](https://urdf.deyuf.org) is.

## VS Code

VS Code 1.86 or later, on Windows, macOS or Linux.

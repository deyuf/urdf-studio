---
title: Settings
order: 90
---

# Settings

All five settings exist on both the web app and the VS Code extension,
backed by different stores.

| Setting | Default | Effect |
|---|---|---|
| **Default render mode** | `visual` | Initial geometry layer on every load. `visual`, `collision`, or `both`. |
| **Up axis** | `+Z` | World up axis used by the camera and ground grid. `+X` / `+Y` / `+Z`. |
| **Default xacro args** | `{}` | JSON object merged into every xacro file's `xacro:arg` values before expansion. Useful for permanently flipping a project-wide flag. |
| **Extra package roots** | `[]` | Additional directories scanned for `package.xml`, in addition to the folder you opened. Each entry may be absolute or relative to the folder root. |
| **Semantic files** | `[]` | SRDF or YAML files providing joint groups and named states. If empty, URDF Studio scans each discovered package's `config/` directory for `.srdf` and `initial_positions.yaml`. |

## Where they live

| Host | Storage | Scope |
|---|---|---|
| Web | `localStorage` key `urdf-studio:settings:v1` | Per-browser-profile. |
| VS Code | `urdfStudio.*` keys in `settings.json` | Per-workspace (or user, if you prefer). |

The web app exposes them through the ⚙ button in the topbar. Save
applies on the next load — current robot is not re-rendered automatically.

## Per-robot vs. global

Settings are global (applied to every robot in the current
browser-profile / workspace). Pose and bookmarks are
[per-document](./poses.html).

## Examples

Treat every xacro file as if `arm_id=fp3` is set:

```jsonc
// VS Code settings.json
"urdfStudio.defaultXacroArgs": { "arm_id": "fp3" }
```

```json
// Web — Settings → Default xacro args
{
  "arm_id": "fp3"
}
```

Always start in collision view (useful when authoring collision meshes):

```jsonc
"urdfStudio.defaultRenderMode": "collision"
```

Add a workspace outside the current folder:

```jsonc
"urdfStudio.packageRoots": [
  "/opt/ros/humble/share",
  "~/ros2_ws/src"
]
```

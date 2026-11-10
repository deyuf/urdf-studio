---
title: Packages, xacro args and settings
order: 90
summary: Make package:// paths resolve, set default xacro arguments, load SRDF files, and change the default view.
---

# Packages, xacro args and settings

## Open settings

- **Browser:** the gear button in the top bar → **Model settings…**.
  Saving applies the changes to the open robot straight away, keeping
  its pose and camera.
- **VS Code:** **Settings** → search for *URDF Studio*, or edit
  `.vscode/settings.json` with the `urdfStudio.*` keys shown below.

## All settings

| Setting | VS Code key | Default | What it does |
|---|---|---|---|
| Default render mode | `urdfStudio.defaultRenderMode` | `visual` | The geometry shown when a robot opens: `visual`, `collision` or `both` |
| Up axis | `urdfStudio.upAxis` | `+Z` | Which way is up: `+X`, `+Y` or `+Z` |
| Default xacro args | `urdfStudio.defaultXacroArgs` | `{}` | Argument values applied to every xacro file |
| Extra package roots | `urdfStudio.packageRoots` | `[]` | More folders to search for `package.xml` |
| Semantic files | `urdfStudio.semanticFiles` | `[]` | SRDF or YAML files for planning groups and named states |

Settings apply to every robot. Poses and bookmarks are kept per robot —
see [Save poses and export](./poses.html).

## Make `package://` paths resolve

A path like `package://franka_description/meshes/link0.dae` needs the
folder of the `franka_description` package — the one with its
`package.xml`.

- **Browser:** open a folder that contains every package the robot uses,
  such as your workspace's `src` folder. Packages outside the opened
  folder can't be reached, because the browser only sees what you opened.
- **VS Code:** every folder in the workspace is searched. Add other
  locations, such as installed packages, with **Extra package roots**:

  ```jsonc
  "urdfStudio.packageRoots": [
    "/opt/ros/humble/share",
    "~/other_ws/src"
  ]
  ```

  Relative paths are relative to the first workspace folder.

## Set xacro arguments

Many xacro files take arguments: which hand to attach, a name prefix,
whether to include a gripper. To change them for one robot, use
**Xacro parameters** in the Joints tab — see
[Pose the robot](./joints.html#change-xacro-parameters).

To apply values to every robot, set **Default xacro args** as a JSON
object:

```json
{
  "arm_id": "fp3",
  "hand": "true"
}
```

```jsonc
// VS Code
"urdfStudio.defaultXacroArgs": { "arm_id": "fp3", "hand": "true" }
```

## Load an SRDF

URDF Studio automatically reads `.srdf` files and `initial_positions.yaml`
from each package's `config/` folder. If yours live elsewhere — a MoveIt
config package, for example — list them under **Semantic files**, one per
line in the browser:

```jsonc
"urdfStudio.semanticFiles": [
  "src/fr3_moveit_config/config/fr3.srdf"
]
```

The SRDF supplies the joint groups and named-state buttons in the
[Joints tab](./joints.html#named-states-from-srdf).

## Colours

The gear menu also has **Classic colors**, which switches to the original
blue colour scheme. In the browser, the sun / screen / moon buttons in the
top bar choose light, system or dark mode.

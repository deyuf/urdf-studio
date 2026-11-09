---
title: Use it in VS Code
order: 2
summary: Install the URDF Studio extension to preview URDF and xacro files inside VS Code, with problems in the Problems panel and code navigation.
---

# Use it in VS Code

The extension adds a 3D preview for robot files and editor support for
URDF and xacro.

## Install

Search for **URDF Studio** in the Extensions view, or install it from the
[Marketplace](https://marketplace.visualstudio.com/items?itemName=deyuf.urdf-studio).

## Open a preview

`.urdf`, `.urdf.xacro` and `.xacro` files open in the URDF Studio preview by
default. To get there from a file open as text:

- Click the **Open Preview** button in the editor title bar, or
- Run **URDF Studio: Open Preview** from the Command Palette
  (**Ctrl+Shift+P** / **⌘⇧P**), or
- Right-click the file in the Explorer → **Open With…** → **URDF Studio
  Preview**.

To edit the text, use **Open With… → Text Editor**, or open the same file
in a split.

## Make `package://` paths resolve

URDF Studio looks for `package.xml` files in every folder of your
workspace. Open your ROS workspace (or the `src` folder) rather than a
single package, and meshes from other packages will be found too.

If packages live outside the workspace — for example installed ones in
`/opt/ros` — add them in your settings:

```jsonc
// .vscode/settings.json
{
  "urdfStudio.packageRoots": [
    "/opt/ros/humble/share",
    "~/other_ws/src"
  ]
}
```

More options: [Packages, xacro args and settings](../features/settings.html).

## What you get in the text editor

These work in any `.urdf` or `.xacro` file open as text:

- **Problems** — the same checks as the preview's Checks tab, with line
  numbers, in the Problems panel.
- **Quick fixes** — the light bulb offers fixes for common problems such as
  a missing `<limit>` or `<inertial>`. See
  [Checks reference](../reference/checks.html#quick-fixes).
- **Hover** over a link or joint name to see its type, parent joint, limits
  or mass.
- A **summary line** above the robot (links and movable joints) opens the
  preview when clicked.
- **Go to Definition** and **Find All References** between joints and the
  links they name.
- **Outline** and breadcrumbs list every link and joint.

## Where things are saved

| Action | Result in VS Code |
|---|---|
| Save pose, bookmarks | Stored in the workspace, per robot file |
| Viewport image | Written to `urdf-studio-screenshots/` in the workspace |
| Joint pose (JSON) | Opens as a new, unsaved JSON document |
| Parts list (CSV), report (PDF) | You choose where in a save dialog |
| Write to SRDF | Updates the SRDF in place, or asks where to create one |
| **Ctrl+S** in the Source tab | Writes a `.urdf`; for `.xacro` files, asks where to save the expanded URDF — see [Edit the source](../features/editing.html) |

## Commands

| Command | What it does |
|---|---|
| URDF Studio: Open Preview | Open the preview for the active file |
| URDF Studio: Recenter | Frame the whole robot |
| URDF Studio: Export Pose | Open the current pose and camera as JSON |
| URDF Studio: Capture Screenshot | Save a PNG of the 3D view |
| URDF Studio: Sample Reachability Cloud | Plot where the tip link can reach |

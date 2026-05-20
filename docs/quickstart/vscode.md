---
title: VS Code extension
order: 2
---

# Quickstart — VS Code extension

The extension wires URDF Studio into VS Code as a custom editor and a set
of language services. It works on any folder you have open in the editor;
no extra setup is needed once installed.

## 1. Install

From the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=deyuf.urdf-studio)
or by running `ext install deyuf.urdf-studio` from the command palette.

## 2. Open a robot

Any of the following opens the preview:

- Right-click a `.urdf`, `.urdf.xacro`, or `.xacro` file in the explorer →
  **Open With** → **URDF Studio Preview**.
- Open the file in the regular text editor and run **URDF Studio: Open
  Preview** from the command palette (⌘⇧P / Ctrl+Shift+P).
- Use the inline editor-title action that appears for URDF/xacro files.

## 3. Resolve `package://`

By default the extension scans every folder in your VS Code workspace for
`package.xml`. Packages found this way are available to every preview.

Add extra roots via settings if your packages live outside the workspace:

```jsonc
// settings.json
{
  "urdfStudio.packageRoots": [
    "~/ros2_ws/src",
    "/opt/ros/humble/share"
  ]
}
```

Paths can be absolute or relative to the first workspace folder.

## 4. Drive and inspect

Same panel layout as the web build — Joints, Inspector, Checks, Links,
Tools. The only difference is the host integration:

- **Save Pose** persists to the workspace state (per-document).
- **Bookmarks** also persist per-workspace.
- **Export Pose** opens a new JSON document next to the URDF.
- **Capture Screenshot** writes a PNG into `urdf-studio-screenshots/`.
- **Disable Collisions** writes directly into your SRDF file.

## 5. Language services

Beyond the preview, the extension provides editor features on URDF and
xacro source:

- **Diagnostics** — every error/warning surfaced inside the preview also
  shows up in the Problems panel, with line numbers.
- **Hover** — joint/link details and resolved mesh paths inline.
- **Go to Definition** / **Find References** — jump between joint
  `parent`/`child` references and their link declarations.
- **Document Symbols** — links and joints appear in the outline and
  breadcrumb.

## Commands

| Command | Effect |
|---|---|
| `URDF Studio: Open Preview` | Open the preview for the active editor. |
| `URDF Studio: Recenter` | Reset the camera to the iso fit. |
| `URDF Studio: Export Pose` | Dump current pose + camera as JSON. |
| `URDF Studio: Capture Screenshot` | Save a PNG. |
| `URDF Studio: Sample Reachability Cloud` | Sample joint poses, plot the tip workspace. |

## Settings

| Key | Default | Effect |
|---|---|---|
| `urdfStudio.packageRoots` | `[]` | Extra directories scanned for `package.xml`. |
| `urdfStudio.defaultXacroArgs` | `{}` | Default xacro args merged into every file. |
| `urdfStudio.defaultRenderMode` | `"visual"` | Initial render layer. |
| `urdfStudio.upAxis` | `"+Z"` | World up axis. |
| `urdfStudio.semanticFiles` | `[]` | SRDF / YAML semantic files. |

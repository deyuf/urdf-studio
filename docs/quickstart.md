# Quickstart

## Web app

1. Open the deployed site in a Chromium-based browser (Chrome, Edge, Brave, Opera, Arc).
2. Click **Open Folder** and pick the root of your ROS package or workspace. The picker only grants read access to the folder you choose.
3. The browser scans for `package.xml` (so `package://` URIs resolve), `.urdf`, `.urdf.xacro`, `.xacro`, and common mesh formats (`.stl`, `.dae`, `.obj`, `.gltf`, `.glb`).
4. If exactly one robot file is found, it loads automatically. Otherwise pick one from the drop-down.
5. Drag the canvas to orbit, scroll to zoom, right-click-drag to pan. Use the joint sliders on the right.

**Safari / mobile fallback.** If your browser doesn't expose `showDirectoryPicker` (Safari, mobile Chrome on iOS), click **Pick Files** instead. The dialog lets you select an entire folder, but the bytes are read into memory up-front, so it's slower for large packages.

## VS Code extension

1. Install **URDF Studio** from the [Marketplace](https://marketplace.visualstudio.com/items?itemName=deyuf.urdf-studio).
2. Right-click any `.urdf`, `.urdf.xacro` or `.xacro` file → **Open With** → **URDF Studio Preview**.
3. The preview reuses your workspace folders to resolve `package://`. Add extra roots via `urdfStudio.packageRoots` in settings if your packages live outside the workspace.

## Settings (web)

Click the ⚙ button in the top bar:

| Setting | Effect |
| --- | --- |
| Default render mode | Geometry layer shown on first load (`visual` / `collision` / `both`). |
| Up axis | World up axis used by the camera. |
| Default xacro args | JSON object merged into every xacro file's args. |
| Extra package roots | Newline-separated paths scanned in addition to the folder you opened. Relative paths are resolved against the folder root. |
| Semantic files | SRDF or YAML files providing joint groups and named states. |

Settings persist in `localStorage` and apply on the next load.

## Saving pose and bookmarks

- **Save Pose** — stores the current pose and camera. Restored next time you open the same robot.
- **Save As…** — names the current pose and adds it to the bookmark dropdown. Pick a name and apply it later.
- **Export Pose** — downloads a JSON file with the pose and camera; useful for sharing.
- **Capture Screenshot** — downloads a PNG of the current viewport.

All of the above are keyed by `<folder>:<file-path>`, so the same file in different folders gets its own state.

---
title: Troubleshooting
summary: Fixes for common problems in URDF Studio — missing meshes, packages not found, xacro errors, folder access and more.
---

# Troubleshooting

## Meshes are missing

The robot loads but some parts are invisible, and Checks shows `A-001`.

1. **Open the package root, not a subfolder.** Choose the folder that
   contains `package.xml` (or a folder above it), not `urdf/` or
   `robots/`. If Checks also shows `A-002`, this is the cause.
2. **Include every package the robot uses.** If the URDF uses meshes from
   another package — a gripper, a sensor — that package must be inside the
   opened folder (browser) or the workspace or **Extra package roots**
   (VS Code). Opening your workspace's `src` folder usually covers it.
3. **Check the file exists.** Select the link; the
   [Inspector](../features/inspector.html) shows the exact path it looked
   for. Mesh files are sometimes not committed to Git, or are stored with
   Git LFS and not downloaded.
4. **Check the format.** STL, DAE, OBJ, glTF and GLB are supported.

## "Missing ROS package" or `$(find …)` fails

The package name in the path doesn't match any `package.xml` in what you
opened. Check the `<name>` inside that package's `package.xml` — it can
differ from the folder name.

## The robot doesn't appear at all

- Look for an error message in the corner of the window — usually XML that
  doesn't parse or xacro that doesn't expand. The message says where.
- Click **Fit** in case the robot is far from the origin or very small.
- If the robot is very large or tiny, its meshes may be in millimetres
  while URDF uses metres. Check `A-003` in Checks and the mesh `scale`.

## Xacro problems

- **An argument has the wrong value** — set it under **Xacro parameters**
  in the Joints tab, or in **Default xacro args**.
- **"Skipped unresolved xacro expression"** — one `${…}` expression
  failed and was left out; the message quotes it. The rest of the robot
  still loads. Often harmless, as with optional TCP offsets.
- **`load_yaml` fails** — the YAML file must be inside the opened folder.

## The robot is lying on its side

The model uses a different up axis. Change **Up axis** in
[settings](../features/settings.html).

## I can't open a folder (browser)

- **Open folder** is greyed out in Firefox and Safari. Use **Pick files**.
- Your browser shows a permission prompt the first time, and again each
  session. If you dismissed it, click **Open folder** again.
- Opening a folder needs a secure page. Use
  [https://urdf.deyuf.org](https://urdf.deyuf.org), not a copy saved to
  disk.

## Pick files is slow

**Pick files** reads every file in the folder up front. Choose the
smallest folder that still contains all needed packages, or use a
Chromium-based browser and **Open folder**, which reads files only when
they are needed.

## Saved poses or bookmarks disappeared (browser)

They are stored in your browser for this site. Private windows, clearing
browsing data, or a different browser or computer start empty. Export a
pose as JSON to keep it elsewhere.

## Joint sliders don't move a joint

- Mimic joints have no slider; move the joint they follow.
- A joint whose `lower` and `upper` limits are equal can't move. Check its
  `<limit>`, or tick **Ignore limits** to explore.

## Is my model uploaded anywhere?

No. In the browser, files are read and processed on your computer; the
site only serves the app itself. In VS Code, everything runs locally.

## Still stuck?

Open an issue on [GitHub](https://github.com/deyuf/urdf-studio/issues) with
the message you see. If you can share the model, attach it — or a
cut-down version that shows the problem.

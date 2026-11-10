<h1 align="center">
  <img src="media/icon.png" alt="" width="88" align="center">
  <br>
  URDF&nbsp;Studio
</h1>

<p align="center">
  <strong>See, pose and check robot models — URDF, xacro and MuJoCo MJCF — in your browser or in VS Code.</strong>
</p>

<p align="center">
  <a href="https://urdf.deyuf.org"><strong>Open in browser</strong></a> ·
  <a href="https://marketplace.visualstudio.com/items?itemName=deyuf.urdf-studio"><strong>Install for VS Code</strong></a> ·
  <a href="https://urdf.deyuf.org/docs/"><strong>Documentation</strong></a>
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=deyuf.urdf-studio"><img src="https://vsmarketplacebadges.dev/version/deyuf.urdf-studio.svg?style=flat-square&labelColor=24292f" alt="Marketplace version"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=deyuf.urdf-studio"><img src="https://vsmarketplacebadges.dev/installs/deyuf.urdf-studio.svg?style=flat-square&labelColor=24292f" alt="Installs"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/deyuf/urdf-studio?style=flat-square&labelColor=24292f" alt="MIT license"></a>
</p>

<p align="center">
  <img src="media/screenshots-web/01-hero.gif" alt="A Franka FR3 arm in URDF Studio: joints are moved with sliders, then the Source and Checks tabs are shown">
</p>

URDF Studio opens `.urdf` and `.xacro` robot descriptions and MuJoCo
(MJCF) models with their meshes and shows the robot in 3D. Move every joint, click any part to see
what it is, compare visual and collision geometry, and get a list of
problems in the model — each linked to the line that causes it.

No ROS installation is needed. In the browser, your files are read
locally and never uploaded.

## What you can do

- **Look at the robot** — orbit, zoom, camera presets; visual geometry,
  collision geometry, or both at once.
- **Pose it** — a slider and exact value for every joint. Mimic joints
  follow, SRDF named states are one click, limits can be ignored to
  explore.
- **Find problems** — missing meshes, broken links in the tree, impossible
  inertias, missing limits, unused xacro arguments — with one-click fixes
  for the common ones.
- **Inspect** — per-link mass, centre of mass, inertia, joint axis and
  limits; coordinate frames, labels and inertia ellipsoids in 3D.
- **Edit with live preview** — change the URDF and see the robot update as
  you type.
- **Prepare for MoveIt** — find link pairs that never collide and write
  them to your SRDF; see where the arm can reach.
- **Share** — save poses and bookmarks, export a PNG, joint values (JSON),
  a parts list (CSV) or an inspection report (PDF).
- **Open MuJoCo models** — view MJCF read-only with the same tools, and
  save it as URDF. Tested against MuJoCo Menagerie robots.

## Get started

### In the browser

1. Go to **[urdf.deyuf.org](https://urdf.deyuf.org)**.
2. Click **Open folder** — or drag a folder onto the page — and choose the
   folder that contains your package's `package.xml`.
3. Pick a robot from the list.

Works best in Chrome, Edge and other Chromium-based browsers. In Firefox
and Safari, use **Pick files** instead.

Don't have a robot to hand? Try
[`franka_description`](https://github.com/frankarobotics/franka_description).
The [first-robot walk-through](https://urdf.deyuf.org/docs/quickstart/)
takes about two minutes.

### In VS Code

1. Install **URDF Studio** from the
   [Marketplace](https://marketplace.visualstudio.com/items?itemName=deyuf.urdf-studio).
2. Open your ROS workspace folder.
3. Open any `.urdf` or `.xacro` file — it opens in the 3D preview.

In the text editor you also get problems in the Problems panel, quick
fixes, hover information, go to definition and an outline of links and
joints.

## Screenshots

<img src="media/screenshots-web/04-checks-health.png" alt="The Checks tab listing missing inertial blocks, with the model health score">

*Checks: every problem, grouped by kind, each one linked to its line.*

<img src="media/screenshots-web/03-editor-fullscreen.png" alt="Full-screen source editor with the 3D view in a corner">

*Edit the URDF full screen; the robot updates in the corner as you type.*

<details>
<summary>More screenshots</summary>

<img src="media/screenshots-web/06-joints-light.png" alt="Light theme with joint sliders">
<img src="media/screenshots-web/02-editor-split.png" alt="Source editor beside the 3D view">
<img src="media/screenshots-web/05-diagnostics-broken.png" alt="A broken URDF with errors in the Checks tab and a message in the corner">

</details>

## Documentation

Full documentation is at **[urdf.deyuf.org/docs](https://urdf.deyuf.org/docs/)**:

- [Your first robot](https://urdf.deyuf.org/docs/quickstart/)
- [Pose the robot](https://urdf.deyuf.org/docs/features/joints.html)
- [Find and fix problems](https://urdf.deyuf.org/docs/features/diagnostics.html)
- [Packages, xacro args and settings](https://urdf.deyuf.org/docs/features/settings.html)
- [Troubleshooting](https://urdf.deyuf.org/docs/help/)

## Common questions

**Meshes don't show up.** Open the folder that contains `package.xml`, not
a subfolder, and make sure every package the robot uses is inside it. More
in [Troubleshooting](https://urdf.deyuf.org/docs/help/#meshes-are-missing).

**Do I need ROS installed?** No. Xacro is expanded by URDF Studio itself,
including `$(find …)`, `xacro:include`, macros and `load_yaml`.

**Which formats are supported?** URDF, xacro, SRDF and MuJoCo MJCF
(read-only); STL, COLLADA, OBJ, glTF and GLB meshes. See
[Supported files and browsers](https://urdf.deyuf.org/docs/reference/formats.html).

**Is my robot model uploaded?** No. The browser version reads your files
on your computer; the extension runs entirely inside VS Code.

## Feedback and contributing

Found a bug or have a model that doesn't load? Please
[open an issue](https://github.com/deyuf/urdf-studio/issues).

Want to work on URDF Studio itself? See [CONTRIBUTING.md](CONTRIBUTING.md)
for building, testing and how the code is organised.

URDF Studio is free and open source under the [MIT license](LICENSE).

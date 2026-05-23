<h1 align="center">
  <img src="media/icon.png" alt="" width="96" align="center">
  <br>
  URDF&nbsp;Studio
</h1>

<p align="center">
  <strong>Inspect, visualize, and drive ROS robot models — in VS Code <em>and</em> in the browser.</strong>
</p>

<p align="center">
  <a href="https://urdf.deyuf.org"><img src="https://img.shields.io/badge/web%20app-urdf.deyuf.org-1a73e8?style=flat-square&labelColor=24292f" alt="Web app"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=deyuf.urdf-studio"><img src="https://vsmarketplacebadges.dev/version/deyuf.urdf-studio.svg?style=flat-square&labelColor=24292f" alt="Marketplace"></a>
  <a href="https://marketplace.visualstudio.com/items?itemName=deyuf.urdf-studio"><img src="https://vsmarketplacebadges.dev/installs/deyuf.urdf-studio.svg?style=flat-square&labelColor=24292f" alt="Installs"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/deyuf/urdf-studio?style=flat-square&labelColor=24292f" alt="License"></a>
</p>

<p align="center">
  <img src="media/screenshots-web/01-hero.gif" alt="URDF Studio walking through key features on a Franka FR3: pose the arm, switch to the Source editor, switch to the Checks panel, return to Joints and re-pose">
</p>

<p align="center">
  <em>Franka FR3 loaded from a local <code>franka_description</code> checkout — full xacro expansion, packages resolved, meshes streamed via blob URLs. The animation cycles through posing the arm, the Source editor, the Checks panel, and back. No server, no install.</em>
</p>

---

## Table of contents

- [Table of contents](#table-of-contents)
- [Quickstart](#quickstart)
  - [Browser](#browser)
  - [VS Code](#vs-code)
- [How it looks](#how-it-looks)
  - [Main view — joints, panels, 3D viewport](#main-view--joints-panels-3d-viewport)
  - [Source editor with syntax highlighting, lint markers, and live preview](#source-editor-with-syntax-highlighting-lint-markers-and-live-preview)
  - [Fullscreen source — IDE mode with a picture-in-picture viewport](#fullscreen-source--ide-mode-with-a-picture-in-picture-viewport)
  - [Checks panel with health score and grouped rules](#checks-panel-with-health-score-and-grouped-rules)
  - [Diagnostics surface as a bottom-corner toast and a populated Checks list](#diagnostics-surface-as-a-bottom-corner-toast-and-a-populated-checks-list)
- [Features](#features)
  - [🖥 Viewing](#-viewing)
  - [🦾 Driving](#-driving)
  - [🩺 Analysing](#-analysing)
  - [🛠 Authoring](#-authoring)
  - [🤖 ROS / URDF / xacro](#-ros--urdf--xacro)
- [Tested models](#tested-models)
- [Configuration](#configuration)
- [Architecture](#architecture)
- [Local development](#local-development)
- [Contributing \& license](#contributing--license)

---

## Quickstart

URDF Studio ships two artifacts from one codebase. Pick the one that
matches how you work.

### Browser

1. Open [**urdf.deyuf.org**](https://urdf.deyuf.org) in Chrome / Edge / Brave / Arc.
2. Click **Open Folder** → pick a ROS package (try a cloned
   [`franka_description`](https://github.com/frankarobotics/franka_description)).
3. Pick a robot file from the dropdown. The viewport loads on the spot.

> Safari / iOS / Firefox don't expose the File System Access API — use
> the **Pick Files** button (`webkitdirectory` fallback) instead. Bytes
> never leave your machine either way.

### VS Code

1. Install [**deyuf.urdf-studio**](https://marketplace.visualstudio.com/items?itemName=deyuf.urdf-studio)
   from the Marketplace — or sideload from source (see below).
2. Right-click a `.urdf`, `.urdf.xacro`, or `.xacro` file → **Open With**
   → **URDF Studio Preview**.
3. The custom editor opens. Workspace package roots are auto-discovered.

Sideload from source:

```bash
git clone https://github.com/deyuf/urdf-studio && cd urdf-studio
npm ci
npm run vsce:package                          # produces urdf-studio-<version>.vsix
code --install-extension urdf-studio-*.vsix   # or: VS Code → Extensions → ⋯ → Install from VSIX
```

Full docs: **<https://urdf.deyuf.org/docs/>**.

---

## How it looks

### Main view — joints, panels, 3D viewport

<img src="media/screenshots-web/01-hero.png" alt="Franka FR3 loaded in URDF Studio with joint sliders, link tree, and a 3D viewport">

The browser app loads a real ROS package off the local disk. Xacro is
expanded client-side, every `package://` URI is resolved to a blob URL
by the host, and meshes stream in via Three.js's `LoadingManager`.
Joint sliders on the right drive the model in real time. The side
panel tabs (Joints / Inspector / Checks / Links / Source / Tools)
share the same data model — clicking a link in the tree or in the
viewport jumps straight to the inspector or the source line.

### Source editor with syntax highlighting, lint markers, and live preview

<img src="media/screenshots-web/02-editor-split.png" alt="CodeMirror 6 source editor showing Franka FR3 URDF in the default split layout">

The Source tab is a full CodeMirror 6 editor: URDF-aware highlighting
(structural tags, xacro namespace, `package://` URIs, `${expr}` blocks
each get distinct colour), inline lint markers that share rule codes
with the Checks panel, intelligent completion (start typing
`<parent link="` and the editor offers every declared link name), and
**live preview** — edits push through to the 3D viewport after a 160 ms
debounce. `Ctrl+S` saves back to disk (VS Code workspace edit, or
FileSystemAccess writable in the browser).

### Fullscreen source — IDE mode with a picture-in-picture viewport

<img src="media/screenshots-web/03-editor-fullscreen.png" alt="Source editor in fullscreen mode with the 3D viewport shrunk into a corner PIP">

Hit `F11` (or `Ctrl+Shift+F`) and the editor takes the whole canvas
while the 3D view shrinks into a corner PIP — read a tight 700-line
xacro on a small screen without losing the live model preview.

### Checks panel with health score and grouped rules

<img src="media/screenshots-web/04-checks-health.png" alt="Checks panel showing a 100/100 health score for a clean URDF">

Every diagnostic surfaces here, grouped by rule code (`R-xxx`
structural, `P-xxx` physics, `A-xxx` assets, `S-xxx` style/xacro). A
0–100 health score quantifies overall fitness — useful when iterating
on a model to clear errors quickly. Click any row to jump to the
offending line in the Source tab.

### Diagnostics surface as a bottom-corner toast and a populated Checks list

<img src="media/screenshots-web/05-diagnostics-broken.png" alt="Broken URDF loaded — Checks panel lists multiple issues grouped by rule code, and a parse-error toast appears at the bottom">

When the parser or analyser finds problems, they surface two ways at
once. Every diagnostic shows up in the **Checks** panel grouped by
rule code (with severity, message, and source line). Errors and
warnings also trigger a bottom-corner toast that pops up automatically
and links the user back to the Checks panel; error toasts stick until
dismissed, warning toasts auto-fade.

## Features

Feature pages in the docs go into much more detail; this is the
overview.

### 🖥 Viewing

| | |
|---|---|
| **3D viewport** | Orbit / pan / zoom (OrbitControls), presets (Front / Right / Top / Iso), one-click Fit. |
| **Render modes** | `Visual`, `Collision`, or `Both` — see [Render modes →](https://urdf.deyuf.org/docs/features/render-modes.html) |
| **Frames & inertia** | Per-link TF axes (off / selected / all) and inertia ellipsoids + CoM markers. |
| **Configurable up axis** | `+X`, `+Y`, `+Z` — grid and camera adjust together. |
| **Wireframe overlay** | Spot cracks, inverted normals, high-poly collision meshes. |

### 🦾 Driving

| | |
|---|---|
| **Joint sliders** | Live sliders + numeric inputs honoring `<limit>` for `revolute`, `continuous`, `prismatic`. |
| **Mimic propagation** | `<mimic>` joints follow their master, with limit-clamp bypass so propagation isn't truncated. |
| **Ignore limits** | One-click bypass of every joint's `<limit>` for exploration. |
| **Search & filter** | Substring filter, *only modified* toggle. |
| **Named states** | SRDF `<group_state>` blocks appear in the bookmark dropdown — see [Joints →](https://urdf.deyuf.org/docs/features/joints.html) |

### 🩺 Analysing

| | |
|---|---|
| **Checks panel** | Every parse error, missing mesh, malformed inertia, joint cycle. [Catalog →](https://urdf.deyuf.org/docs/features/diagnostics.html) |
| **Link tree & inspector** | Click anywhere on the robot or tree → see joints, mass, CoM, inertia tensor, mesh paths. |
| **Diagnostics in VS Code** | Same checks surface in the Problems panel with line numbers. |

### 🛠 Authoring

| | |
|---|---|
| **Source editor (CodeMirror 6)** | URDF/xacro syntax highlighting, **live edit ↔ 3D preview** (debounced ~160 ms), **intelligent completion** (link/joint/joint-type/`package://` names), and **inline lint markers**. Toggle "Edit: on" from the Source tab. |
| **Lint rule engine** | 18 rules covering structural (`R-001..005`), physics (`P-001..006`), assets (`A-001..003`), and xacro style (`S-001..005`). Grouped Checks panel with **health score** (0-100). |
| **Quick fixes** | One-click fixes for missing `<limit>`, missing `<inertial>`, negative mass, zero effort/velocity, and stray limit on `continuous` joints. |
| **Fullscreen source view** | `F11` (or `Ctrl+Shift+F`) flips the source pane to full width with the 3D viewport shrunk to a picture-in-picture corner — read tight URDF on a small screen. |
| **3D screenshot** | Tools tab → **Save PNG** writes a transparent-background snapshot of the current viewport at 1×/2×/3×/4× scale; **Copy to clipboard** for instant paste into PRs/docs. |
| **Reachability sampling** | Monte-Carlo workspace point cloud for any tip link. |
| **Never-colliding pairs** | Sample for `<disable_collisions>` entries → write merged SRDF. |
| **Pose & bookmarks** | Save pose, name bookmarks, restore on next open. |
| **Export** | JSON pose with camera; PDF report bundling screenshot + checks + summary; BOM CSV. |

### 🤖 ROS / URDF / xacro

| | |
|---|---|
| **xacro expansion** | `xacro:include`, `xacro:macro`, `xacro:arg`, `load_yaml`, Python ternary / `**` / slice rewrites. |
| **`package://` URIs** | Auto-discovered from every `package.xml` in scope. |
| **Mesh formats** | STL · COLLADA · OBJ · glTF · GLB. DAE / GLTF external assets pre-resolved to blob URLs. |
| **SRDF** | Joint groups, named states, `disable_collisions`. |

---

## Tested models

End-to-end Playwright smoke test against the upstream
[`franka_description`](https://github.com/frankarobotics/franka_description)
package. Reproducer:

```bash
git clone https://github.com/frankarobotics/franka_description /tmp/franka_description
npm run web:build
FRANKA_DIR=/tmp/franka_description node scripts/test-franka.mjs
```

| Robot | Source | Result |
|---|---|---|
| Franka Research 3 (`fr3`) | franka_description | ✅ 8 joints · 25 links · 0 errors · 0 warnings · ~600 ms |
| Franka Research (`fer`)   | franka_description | ✅ 8 joints · 25 links · 0 errors · 0 warnings · ~800 ms |
| Franka Production 3 (`fp3`) | franka_description | ✅ 8 joints · 25 links · 0 errors · 0 warnings · ~600 ms |

The whole pipeline runs in the browser: directory pick, xacro expansion
(including `load_yaml` for joint limits / inertials YAMLs), package
resolution, mesh blob URL allocation, Three.js render.

---

## Configuration

Both targets expose the same five settings.

| Setting | Default | Effect |
|---|---|---|
| Default render mode | `visual` | Geometry layer on first load. |
| Up axis | `+Z` | World up axis used by camera and grid. |
| Default xacro args | `{}` | Args merged into every xacro file. |
| Extra package roots | `[]` | Extra `package.xml` scan roots. |
| Semantic files | `[]` | SRDF / YAML semantic files. |

**Web:** ⚙ button in the topbar → JSON in `localStorage`.
**VS Code:** `urdfStudio.*` keys in `settings.json`.

Details: [docs/features/settings →](https://urdf.deyuf.org/docs/features/settings.html)

---

## Architecture

A single TypeScript codebase produces both targets:

```
                src/core/                 — pure logic, no fs/path/DOM imports
                     ▲
       ┌─────────────┴─────────────┐
   io.node.ts                   ioBrowser.ts
   (jsdom + node:fs)            (FileSystemAccess + native DOM)
       ▲                              ▲
  src/extension.ts               src/web/host.ts
       ▲                              ▲
       └─────────── postMessage ──────┘
                     ▼
              src/renderer/main.ts     — Three.js + URDFLoader, identical
```

The core never touches Node-only modules directly; it queries a
`CoreIo` interface set by the host. The renderer is bundled separately
and is identical on both targets — the only thing that differs is the
postMessage source.

Deep dive: [docs/architecture →](https://urdf.deyuf.org/docs/architecture/)

---

## Local development

```bash
git clone https://github.com/deyuf/urdf-studio
cd urdf-studio
npm ci
```

Common loops:

```bash
# VS Code extension
npm run watch              # incremental rebuild; press F5 in VS Code

# Web app
npm run web:dev            # http://127.0.0.1:5173 with HMR

# Docs only
npm run docs:watch         # rebuild dist-web/docs on every .md change

# Tests
npm run test:unit          # 24 node:test cases on src/core
npx playwright test        # 19 renderer + web shell specs

# Real-world smoke
FRANKA_DIR=/tmp/franka_description node scripts/test-franka.mjs
```

Production builds:

```bash
npm run package            # VS Code extension (dist/)
npm run web:build          # web app + docs (dist-web/)
npm run vsce:package       # .vsix for sideload / Marketplace
# then: code --install-extension urdf-studio-*.vsix
```

More: [docs/development/building →](https://urdf.deyuf.org/docs/development/building.html)


---

## Contributing & license

PRs welcome.

License: [MIT](LICENSE).

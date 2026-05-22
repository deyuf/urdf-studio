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
  <img src="media/screenshots-web/03-fr3-posed.png" alt="Franka Research 3 loaded in the web app">
</p>

<p align="center">
  <em>Franka Research 3 loaded directly from a local <code>franka_description</code> checkout — full xacro expansion, packages resolved, meshes streamed via blob URLs. No server.</em>
</p>

---

## Table of contents

- [Table of contents](#table-of-contents)
- [Quickstart](#quickstart)
  - [Browser](#browser)
  - [VS Code](#vs-code)
- [How it looks](#how-it-looks)
  - [Web app — Franka FR3 loaded](#web-app--franka-fr3-loaded)
  - [VS Code extension — same robot, in-editor](#vs-code-extension--same-robot-in-editor)
  - [Inspector — link details on click](#inspector--link-details-on-click)
  - [Diagnostics surface as a bottom-corner toast](#diagnostics-surface-as-a-bottom-corner-toast)
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

### Web app — Franka FR3 loaded

<img src="media/screenshots-web/03-fr3-posed.png" alt="Franka Research 3 loaded in the web app">

The browser app loads a real ROS package off the local disk. The
screenshot above is the upstream
[`franka_description`](https://github.com/frankarobotics/franka_description)
checkout, picked through **Open Folder**: xacro is expanded
client-side, every `package://` URI is resolved to a blob URL by the
host, and the meshes stream in via Three.js's `LoadingManager`. Joint
sliders on the right drive the model in real time; the three joints in
this shot are flexed to ~0.8 / -1.2 / 1.6 rad.

### VS Code extension — same robot, in-editor

<img src="media/screenshots/viewer-joints.png" alt="URDF Studio open as a VS Code custom editor">

In VS Code, opening any `.urdf`, `.urdf.xacro`, or `.xacro` file
through the custom editor yields the same viewport, the same joint
panel, the same Inspector / Checks / Links / Tools tabs. The host shell
differs (extension process + webview vs browser-side host) but the
renderer and analyser are byte-for-byte identical — see
[Architecture](docs/architecture/) for how the two hosts share core.

### Inspector — link details on click

<img src="media/screenshots/inspector-selected.png" alt="Inspector showing link details with bounding box highlight">

Click any link in the viewport or in the **Links** tree to open the
Inspector. It shows the parent and child joints with type/axis/limits,
mass, center of mass, the full inertia tensor with eigenvalues, and
the resolved absolute paths of every visual and collision mesh
referenced by that link. The selected link gets a tight yellow
bounding box on its own visual geometry.

### Diagnostics surface as a bottom-corner toast

<img src="media/screenshots-web/11-toast-error.png" alt="Error toast pop-up listing parse problems">

When the parser or analyser finds problems, they are surfaced two ways
at once. Every diagnostic shows up in the **Checks** panel with its
severity, stable code, and source line. Errors and warnings also
trigger a bottom-right toast: it pops up automatically, lists the
first three messages, and links the user back to the Checks panel via
the "see Checks tab" overflow line. Error toasts are sticky (manual
dismiss); warning toasts auto-fade after a few seconds.

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
| **Reachability sampling** | Monte-Carlo workspace point cloud for any tip link. |
| **Never-colliding pairs** | Sample for `<disable_collisions>` entries → write merged SRDF. |
| **Pose & bookmarks** | Save pose, name bookmarks, restore on next open. |
| **Export & screenshot** | JSON pose with camera; PNG screenshot at native resolution. |

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

---
title: Overview
---

# URDF Studio

A single TypeScript codebase that lets you inspect, visualize and drive
ROS robot models — as a **VS Code extension** for in-editor previews, and
as a **browser app** that runs entirely client-side.

## What you can do with it

| | |
|---|---|
| 🖥 **See the robot** | Three.js viewport with orbit/pan/zoom, preset cameras, fit-to-screen, visual + collision render modes. |
| 🦾 **Drive joints** | Sliders and numeric inputs for every movable joint, respecting `<limit>` and `<mimic>`. |
| 🤖 **Expand xacro** | Full `xacro:include`, `xacro:macro`, `xacro:arg`, `load_yaml` support — both in Node and in the browser. |
| 📦 **Resolve `package://`** | Auto-discovers `package.xml` files in the workspace or chosen folder. |
| 🧭 **Inspect** | Link tree, parent/child joints, mass, CoM, inertia tensor, mesh paths, tight bounding box. |
| 🩺 **Validate** | URDF parse errors, missing meshes, non-positive-definite inertias, joint cycles — surfaced inline. |
| 🛠 **Author** | Reachability sampling, never-colliding pair detection, SRDF authoring. |
| 💾 **Persist** | Save pose, name bookmarks, export pose JSON, capture PNG screenshots. |

## Which version do I want?

- **You write robot descriptions in VS Code** → use the [extension](./quickstart/vscode.html).
  Inline diagnostics, custom editor, language services.
- **You want to share a preview** or open a model on someone else's machine
  → use the [web app](./quickstart/web.html).
  No install, runs in the browser, files never leave the device.

Both expose the same feature set on top of the same parser, renderer and
analyzer. See [Architecture](./architecture/) for how that's organised.

## Project layout

- Source: <https://github.com/deyuf/urdf-studio>
- VS Code Marketplace: [deyuf.urdf-studio](https://marketplace.visualstudio.com/items?itemName=deyuf.urdf-studio)
- Web app: deployed at any static host (Cloudflare Pages reference deploy)
- License: MIT

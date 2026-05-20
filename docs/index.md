# URDF Studio

URDF Studio inspects, visualizes and interacts with [URDF](http://wiki.ros.org/urdf) and [xacro](http://wiki.ros.org/xacro) robot models. The same codebase ships in two forms:

- **VS Code extension** — works on any `.urdf`, `.urdf.xacro` or `.xacro` file in your workspace.
- **Web app** — runs entirely in the browser via the File System Access API. No server, no upload; everything stays on your machine.

## Pages

- [Quickstart](./quickstart.html) — Open your first robot in under a minute.
- [Features](./features.html) — Joints, render modes, frames, inertia, reachability, bookmarks.
- [Architecture](./architecture.html) — How the VS Code host and the browser host share a single core.
- [Development](./development.html) — Building, testing, deploying.

## What you'll see

A full Three.js viewport with orbit/pan/zoom controls, a joint panel with sliders for every movable joint, a render-mode toggle (visual / collision / both), a link tree, and a checks panel that flags malformed URDF, missing meshes, non-positive-definite inertia tensors, and unreachable links.

## Source

- Repository: https://github.com/deyuf/urdf-studio
- License: MIT

---
title: Architecture
order: 0
---

# Architecture

URDF Studio runs in two environments — the VS Code extension host and a
browser tab served from any static host — from a **single TypeScript
codebase**. This section explains how that's organized.

## At a glance

```
┌────────────────────────────────────────────────────────────────────┐
│                         src/core/                                  │
│  XML parser · URDF analyzer · xacro expander · SRDF parser         │
│  Pure logic. No fs, no path, no DOM imported directly.             │
│  Talks to the host through CoreIo (injected).                      │
└────────────────────────────────────────────────────────────────────┘
            ▲                                       ▲
            │  setCoreIo(nodeImpl)                  │  setCoreIo(browserImpl)
            │                                       │
┌───────────┴────────────┐              ┌───────────┴────────────┐
│  src/extension.ts      │              │  src/web/host.ts       │
│  src/core/io.node.ts   │              │  src/web/ioBrowser.ts  │
│  jsdom · node:fs/path  │              │  FileSystemAccess · DOM│
└───────────┬────────────┘              └───────────┬────────────┘
            │  postMessage                          │  window.postMessage
            ▼                                       ▼
┌────────────────────────────────────────────────────────────────────┐
│                       src/renderer/main.ts                         │
│  Three.js · URDFLoader · OrbitControls · joint UI · panels         │
│  Identical on both targets. Talks to host via postMessage.         │
└────────────────────────────────────────────────────────────────────┘
```

## What's in this section

- [Core](./core.html) — the `CoreIo` abstraction, what's pure and what's
  not.
- [Renderer](./renderer.html) — message protocol, URL modifier, blob
  lifecycle.
- [Browser host](./browser.html) — VFS, package discovery, yaml pre-warm.
- [VS Code host](./vscode.html) — webview wiring, custom editor,
  workspace state.

# Architecture

URDF Studio runs in two environments — the VS Code extension host and a browser tab on Cloudflare Pages — from a single TypeScript codebase. This page explains how that's organized.

## Module layout

```
src/
  core/          Pure analysis: parses URDF, expands xacro, analyzes
                 inertia/kinematic tree, parses SRDF. Knows nothing about
                 fs or DOM; everything is injected via core/io.ts.
    io.ts        CoreIo interface + singleton + setter.
    io.node.ts   Node implementation (fs, path, jsdom). Used by extension.ts.

  renderer/      Three.js + URDFLoader. Talks to its host via window
                 postMessage. ~1800 lines, identical on both targets.

  extension.ts   VS Code host. Installs the Node CoreIo, drives the
                 webview, owns settings/state via vscode.workspace.
  languageFeatures.ts  VS Code-only diagnostic integration.

  web/           Browser host (everything below).
    main.ts        Entry. Installs CoreIo, host, UI, then imports renderer.
    host.ts        Equivalent of extension.ts for the browser.
    ioBrowser.ts   CoreIo wired to BrowserVfs + native DOMParser.
    storage.ts     localStorage for pose / bookmarks / settings.
    ui/app.ts      Top-bar UI: folder picker, file dropdown, settings dialog.
    ui/web.css     CSS variables + topbar layout.
    vfs/
      types.ts            BrowserVfs interface.
      directoryHandle.ts  File System Access API impl.
      fileList.ts         webkitdirectory fallback.
      posixPath.ts        Tiny path utility (browser has no node:path).
```

## Message protocol

The renderer is decoupled from its host through a postMessage protocol:

```
host → renderer: loadRobot, recenter, exportPose, captureScreenshot,
                 sampleReachability, requestPoseSnapshot,
                 bookmarksUpdated, disableCollisionsUpdated
renderer → host: ready, geometryLoaded, exportPoseResult,
                 screenshotResult, poseSnapshot, requestSavePose,
                 requestSaveBookmark, requestDeleteBookmark,
                 requestRenameBookmark, reloadWithXacroArgs,
                 jointChanged, selectionChanged,
                 requestWriteDisableCollisions
```

In VS Code the host runs in Node and talks to the webview via `webview.postMessage`. In the browser, both sides are on the page and use `window.postMessage` plus a shim that exposes `acquireVsCodeApi()` to the renderer.

## File URIs

Three.js loaders fetch meshes via URLs. To support a virtual filesystem in the browser without losing relative-path semantics inside DAE or GLTF files, the host emits a synthetic scheme: `urdf-studio-vfs:///<abs-path>`. The renderer registers a `LoadingManager.setURLModifier` that maps these URLs to blob URLs at fetch time.

Mesh files are blob-URL'd eagerly during `loadRobot`. DAE files are pre-parsed for `<image>` / `<init_from>` references; GLTF JSONs are pre-parsed for buffer and image URIs. This keeps the URL modifier synchronous (a Map lookup) while still resolving nested texture references inside Collada/GLTF.

GLB binaries embed all assets, so no pre-parsing is needed.

## Blob URL lifecycle

`URL.createObjectURL` pins the underlying `File` until you call `URL.revokeObjectURL`. To prevent leaks across reloads, BrowserVfs maintains a **two-generation cache**:

- `beginGeneration()` at load start moves current URLs to "previous"; any orphaned previous generation (load that never completed) gets revoked.
- `commitGeneration()` runs when the renderer posts `geometryLoaded`. Previous-generation URLs not carried over to the new generation are revoked. Reused meshes are promoted from previous to current rather than re-allocated, so xacro-args reloads don't churn URLs.

A Playwright spec (`test/renderer/web-shell.spec.ts`) verifies the live blob count stays bounded across many reloads.

## YAML pre-warm

xacro's `load_yaml(path)` is called synchronously from inside expression evaluation. In Node we use `readFileSync`; the browser has no sync File access. The host pre-loads every `.yaml`/`.yml` file in the VFS into a sync cache before kicking off xacro expansion. The cost is negligible since YAML files in ROS packages are typically <10 KB each.

A more surgical option (scan the source for `load_yaml('...')` calls) misses the common pattern where the path comes from a xacro property, so the aggressive approach is the simpler correct choice.

## Build

`esbuild.mjs` produces three artifacts:

- `dist/extension.js` — CommonJS, `platform: node`, `vscode` and `xhr-sync-worker.js` external.
- `dist/renderer.js` — ESM, `platform: browser`, targeted at `chrome114` (VS Code's bundled Electron).
- `dist-web/app.js` — ESM, `platform: browser`, targets `chrome114 / firefox115 / safari17`. Marks `jsdom` and `node:*` as external so Node-only code paths in core never get pulled into the browser bundle.

Bundle analysis is part of CI (`node esbuild.mjs --web --production` plus a grep for `jsdom`/`node:`); see `.github/workflows/ci.yml`.

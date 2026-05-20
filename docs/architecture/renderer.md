---
title: Renderer
order: 20
---

# Renderer

`src/renderer/main.ts` (≈1800 lines) owns the Three.js scene, the
URDFLoader call, the joint panel, the link tree, the inspector, the
checks panel, and the tools panel. It is bundled separately and
**identical on both targets** — the only thing that differs is what's
posting messages to it.

## Message protocol

Every interaction between host and renderer goes through `postMessage`:

```
host → renderer
  loadRobot                  full payload (URDF text, metadata, packageMap, …)
  recenter                   reset camera to iso fit
  exportPose                 ask renderer to report current pose
  captureScreenshot          ask renderer to render and report a PNG dataURL
  sampleReachability         trigger reachability sampling
  requestPoseSnapshot        ask renderer to report pose (used for hot reload)
  bookmarksUpdated           push new bookmark list (after add/delete/rename)
  disableCollisionsUpdated   push new disable_collisions list after SRDF write

renderer → host
  ready                      handshake on startup
  geometryLoaded             all meshes finished loading (used to commit blobs)
  poseSnapshot               reply to requestPoseSnapshot
  exportPoseResult           reply to exportPose
  screenshotResult           reply to captureScreenshot
  reloadWithXacroArgs        user changed xacro args; please re-expand
  jointChanged               user moved a joint
  selectionChanged           user selected a link
  requestSavePose            user clicked Save Pose
  requestSaveBookmark        user clicked Save As
  requestDeleteBookmark      user removed a bookmark
  requestRenameBookmark      user renamed a bookmark
  requestWriteDisableCollisions  user clicked Write SRDF in the Tools panel
```

In VS Code this rides on `webview.postMessage` between the extension
process and the webview iframe. In the browser, host and renderer are on
the same page; we use `window.postMessage(msg, '*')` which dispatches a
synchronous `MessageEvent` to the same window's listeners.

## acquireVsCodeApi shim

The renderer calls `acquireVsCodeApi()` once at startup to get a
`{ postMessage, setState, getState }` triple. In the VS Code webview this
is real. In the browser, the host installs a shim before the renderer
loads:

```ts
globalThis.acquireVsCodeApi = () => ({
  postMessage(msg)  { queueMicrotask(() => host.handle(msg)); },
  setState(_)       { /* no-op */ },
  getState()        { return null; }
});
```

The `queueMicrotask` defers handling so the renderer's call site
finishes synchronously first, matching VS Code's behaviour.

## URL modifier and the vfs:// scheme

The renderer never knows what the underlying filesystem looks like. It
only sees the `packageMap` and `sourceBaseUri` fields of the `loadRobot`
message, which the host builds. URDFLoader concatenates these with the
mesh filename to produce a URL like:

```
urdf-studio-vfs:///franka_description/meshes/robots/fr3/visual/link0.dae
```

Three.js can't `fetch` that — there's no real `urdf-studio-vfs:` scheme.
The renderer installs a `LoadingManager.setURLModifier` that maps these
URLs to blob URLs at fetch time:

```ts
if (vfsUrlMap && vfsScheme) {
  manager.setURLModifier(url => {
    if (!url.startsWith(vfsScheme)) return url;
    return vfsUrlMap[url] || vfsUrlMap[normalizeVfsUrl(url, vfsScheme)] || url;
  });
}
```

`normalizeVfsUrl` collapses empty segments (`a//b` → `a/b`), drops `.`,
and resolves `..`. This handles the case where DAE/GLTF files reference
textures with relative paths that resolve outside the visible mesh
directory.

VS Code build never sets `vfsUrlMap`, so the modifier is inert and
URLs pass through to webview-resolved file URIs.

## Blob URL lifecycle

`URL.createObjectURL` pins the underlying File reference; the browser
won't reclaim that memory until you call `URL.revokeObjectURL`. To avoid
leaking on reloads, the [browser VFS](./browser.html#blob-url-lifecycle)
maintains a two-generation cache.

## Renderer-internal mesh cache

Once a mesh has been parsed by Three.js (geometry + materials), the
parsed object is cached in a module-level `meshCache: Map<url, Object3D>`.
Subsequent loads of the same URL clone the cached object rather than
re-parsing. This matters for robots with repeated links (gripper
fingers, multi-axis carriage rails, etc.).

The cache is cleared when a `loadRobot` arrives for a different document,
or when the renderer's reload-with-collision path runs.

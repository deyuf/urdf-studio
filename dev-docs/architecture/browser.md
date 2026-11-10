---
title: Browser host
order: 30
---

# Browser host

`src/web/host.ts` is the browser equivalent of `src/extension.ts`. It
discovers packages, expands xacro, runs URDF analysis, and emits the
`loadRobot` message to the renderer.

## Module layout

```
src/web/
  main.ts             Boot: install CoreIo, host, UI, then import renderer.
  host.ts             The host. Owns the active document, posts loadRobot.
  ioBrowser.ts        CoreIo impl backed by BrowserVfs + native DOM.
  storage.ts          localStorage for pose / bookmarks / settings.
  ui/app.ts           Topbar shell: folder picker, file dropdown, settings.
  ui/onboarding.ts    First-run tour.
  ui/web.css          Visual refresh tokens.
  vfs/
    types.ts          BrowserVfs interface.
    directoryHandle.ts  File System Access API impl.
    fileList.ts       webkitdirectory fallback.
    posixPath.ts      Tiny path utility.
```

## The BrowserVfs interface

Two implementations:

- **`DirectoryHandleVfs`** — wraps a `FileSystemDirectoryHandle`. Lazily
  reads files on demand; only the path index is built up front. Best on
  Chromium-based browsers.
- **`FileListVfs`** — wraps a `webkitdirectory` `FileList`. The browser
  reads file metadata into memory before handing us the list; reads
  happen via `File.text()` / `File.arrayBuffer()`. Used on Safari and
  mobile Chrome where File System Access isn't exposed.

Both implement the same surface: `readText`, `readBytes`, `readTextSync`
(from a pre-warmed cache), `existsSync`, `readdir`, `getBlobUrl`, plus
generation methods.

## Loading a document — what happens

1. User picks a folder. AppShell instantiates a VFS, populates the file
   dropdown with every URDF/xacro file.
2. User selects a file. AppShell calls `host.openDocument(absPath)`.
3. Host runs:
   - `vfs.warmTextCache(allYamlsInVfs)` — every `.yaml`/`.yml` is loaded
     into the sync cache so xacro's `load_yaml()` works synchronously.
     The aggressive variant; targeted regex scans miss indirect refs.
   - `discoverPackages([vfs.root, ...extraRoots])` — recursive scan via
     `io.readdir`/`io.readText`.
   - `renderRobotDocument(absPath, packages, xacroArgs)` — xacro
     expansion using `globalThis.DOMParser` (no jsdom!).
   - `analyzeUrdf(urdf, absPath, packages)` — link/joint graph, mesh
     resolution, inertia checks.
   - `loadSemanticMetadata(semanticFiles, packages)` — SRDF + YAML.
   - `vfs.beginGeneration()` + `preallocateMeshUrls` — see below.
   - `postToRenderer({ type: 'loadRobot', … })`.
4. Renderer receives `loadRobot`, builds the Three.js scene, fetches
   meshes via the URL modifier, eventually posts `geometryLoaded`.
5. Host commits the blob generation (`vfs.commitGeneration()`).

## Blob URL lifecycle

`URL.createObjectURL` pins the underlying File reference. To prevent
leaks across reloads, BrowserVfs uses a **two-generation cache**:

- `beginGeneration()` at load start moves `currentBlobs` to
  `previousBlobs`. Any leftover previous-gen from a load that never
  completed gets revoked here (so abandoned loads don't accumulate).
- `getBlobUrl(path)` first checks `currentBlobs`. If a previous-gen URL
  exists for the same path, it's **promoted** to current rather than
  re-allocated — saves churn when consecutive loads share meshes.
- `commitGeneration()` runs when the renderer posts `geometryLoaded`.
  Previous-gen URLs not carried over are revoked.

A Playwright spec verifies that alternating between two URDFs keeps the
live blob count bounded.

## Pre-allocation: meshes, DAE textures, GLTF assets

URL modifier is synchronous (it returns a string). We can't `await
getBlobUrl` inside it. So before sending `loadRobot`, the host
pre-allocates a URL for every asset that might be fetched:

- Every mesh in `metadata.meshes` with `exists === true`.
- Every external `<image>` / `<init_from>` reference inside the DAE
  files (parsed textually).
- Every external buffer / image referenced in GLTF JSONs (parsed JSON).
- GLB binaries embed their assets — no pre-parsing needed.

The renderer sees the resulting `vfsUrlMap` in `loadRobot` and uses it
to install the URL modifier.

## URI conventions

| Use | Shape | Example |
|---|---|---|
| `sourceBaseUri` (workingPath) | trailing slash REQUIRED | `urdf-studio-vfs:///fr/robots/fr3/` |
| `packageMap[pkg]` | trailing slash FORBIDDEN | `urdf-studio-vfs:///fr` |
| `vfsUrlMap` keys | canonical | `urdf-studio-vfs:///fr/meshes/foo.dae` |

The asymmetry exists because URDFLoader does `packages[pkg] + '/' + relPath`
internally; if our `packageMap` entry had a trailing slash, every URL
would gain a double slash and miss the lookup.

## Settings, pose, bookmarks

All persisted in `localStorage`:

| Key | Shape |
|---|---|
| `urdf-studio:settings:v1` | `UserSettings` object |
| `urdf-studio:pose:v1` | `{ <vfsLabel><absPath>: PreviewState }` |
| `urdf-studio:bookmarks:v1` | `{ <vfsLabel><absPath>: PoseBookmark[] }` |
| `urdf-studio:onboarded:v1` | `'1'` when the tour has been dismissed |

`localStorage` failures (private mode, blocked) degrade to in-memory only.

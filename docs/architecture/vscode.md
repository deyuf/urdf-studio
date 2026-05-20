---
title: VS Code host
order: 40
---

# VS Code host

`src/extension.ts` plays the same role as `web/host.ts` but on top of
the VS Code extension API.

## Activation

The extension's `activate(context)` is called on first use of any URDF
Studio command or when a `.urdf` / `.urdf.xacro` / `.xacro` file is
opened. It:

- Installs the Node `CoreIo` (`./core/io.node`) via side-effect import.
- Creates an output channel and wires it as the global logger.
- Registers `urdfStudio.preview` as a custom editor provider for the
  three file patterns.
- Registers the language features (diagnostics, hover, definitions,
  symbols) on `urdfLanguage`.
- Registers the commands listed below.

## Custom editor

`UrdfStudioProvider` implements `vscode.CustomReadonlyEditorProvider`.
On `resolveCustomEditor`:

1. Reads workspace settings → builds `packageRoots` and `xacroArgs`.
2. Calls `discoverPackages(packageRoots)` (this is async; the webview
   loads in parallel with a "Loading..." placeholder).
3. Sets up the webview's `localResourceRoots` so it can fetch meshes
   from anywhere a discovered package lives.
4. Loads the renderer HTML and posts the initial `loadRobot` payload.
5. Wires up `webview.onDidReceiveMessage` to handle the renderer-to-host
   protocol.
6. Wires a `FileSystemWatcher` on the URDF and every included file so
   changes trigger a re-load (the renderer's pose is preserved via the
   `requestPoseSnapshot` round-trip).

## Webview integration

The renderer is bundled as `dist/renderer.js`. The HTML template
embeds it with a strict CSP:

```
default-src 'none';
img-src ${cspSource} data:;
font-src ${cspSource};
style-src ${cspSource} 'unsafe-inline';
script-src 'nonce-${nonce}';
connect-src ${cspSource} https: data: blob:;
```

`localResourceRoots` is recomputed every time `loadRobot` runs — it
includes the extension URI, every workspace folder, every discovered
package's root, and four parent directories above the URDF (covers
cross-package mesh references without granting blanket fs access).

## Hot reload

Whenever the URDF or any included xacro file changes:

1. The `FileSystemWatcher` fires after a 200ms debounce.
2. Host posts `requestPoseSnapshot` to the renderer.
3. Renderer responds with `poseSnapshot { pose, camera }`.
4. Host stashes this on the preview state and re-runs the load
   pipeline. The new `loadRobot` payload carries the stashed
   `savedState`, so the camera and joint values survive.

## Diagnostics integration

Every diagnostic from the analyzer (see [Diagnostics](../features/diagnostics.html))
also lands in a `vscode.DiagnosticCollection`:

- The Problems panel shows them with file/line info.
- They live-update as you edit (the language feature provider re-runs
  analysis on text change without re-expanding xacro for performance).
- A separate code path drives the preview's Checks panel from the same
  source, so they stay in sync.

## Save outputs

| Action | Output |
|---|---|
| Save Pose | `workspaceState['urdfStudio.previewState:<uri>']` |
| Save Bookmark | `workspaceState['urdfStudio.bookmarks:<uri>']` |
| Export Pose | New untitled JSON document, opened in an editor tab. |
| Capture Screenshot | `urdf-studio-screenshots/<filename>-<timestamp>.png` at workspace root. |
| Write Disable Collisions | Merged into the SRDF source file (or a new `<basename>.srdf` if none was loaded). |

## Language features

`src/languageFeatures.ts` provides:

- **Document symbols** — every `<link>` and `<joint>` becomes a symbol
  with the right kind.
- **Definitions** — `parent link="..."` and `child link="..."` jump to
  the corresponding `<link name="...">`.
- **References** — find every joint that references a given link.
- **Hover** — joint type, axis, limits, mass, resolved mesh paths.

These run on the raw URDF/xacro text (no expansion) for performance. The
preview always uses fully expanded URDF.

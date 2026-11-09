---
title: Source editing
order: 65
---

# Source editing

The **Source** tab shows the document the preview is built from, in a
CodeMirror editor with URDF-aware highlighting, completion for link, joint
and package names, and inline diagnostics from the Checks panel.

## Controls

| Control | Effect |
|---|---|
| **Edit** | Toggles the editor between read-only (default) and editable. |
| **Fullscreen** | Expands the Source tab over the viewport (also F11 / Ctrl+Shift+F). |
| Gutter line number | In VS Code, reveals that line in an open text editor for a plain URDF. |
| **Ctrl/Cmd+S** | Saves the editor contents — see below. |

## Live preview

While **Edit** is on, every change is sent back to the host (debounced,
longer for large models), re-analyzed and re-rendered. Nothing is written to
disk until you save.

## Saving

| Opened file | VS Code | Browser |
|---|---|---|
| `.urdf` | Writes the editor contents back to the file. The file watcher reloads the preview from disk. | Downloads the contents under the same file name (the browser cannot write into the opened folder). |
| `.xacro` / `.urdf.xacro` | Opens **Save expanded URDF as…** next to the source, defaulting to `<name>.urdf`. The `.xacro` file is never written. | Downloads the expanded result as `<name>.urdf`. |

## Editing xacro files

For a xacro document the Source tab shows the **expanded** URDF — the
header says `(expanded xacro)`. Macros, properties, includes and
`<xacro:arg>`s have already been resolved, so this text cannot be turned
back into the original xacro.

Because of that, saving from the Source tab never touches xacro source:

- The editor's status bar says that save writes a separate `.urdf` and that
  the `.xacro` is never overwritten (hover it for details).
- In VS Code, Ctrl/Cmd+S asks where to save the expanded URDF. Cancelling
  writes nothing. Choosing a `.xacro` file name is refused with a warning.
  The preview keeps showing the xacro; the new `.urdf` is a snapshot.
- In the browser, the download is named `<name>.urdf` (for example
  `fr3.urdf.xacro` → `fr3.urdf`), so it cannot be mistaken for the source.

To change the robot itself, edit the `.xacro` (and its included files) in a
normal text editor. The preview reloads automatically when any of them
change on disk.

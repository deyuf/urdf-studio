---
title: Pose, bookmarks, export
order: 80
---

# Pose, bookmarks, export

URDF Studio persists what you do with a robot — pose, named bookmarks,
and one-shot exports for sharing.

## Save Pose

The **Save Pose** button in the right-side toolbar group stores:

- Every movable joint's current value.
- The camera position, target, and up vector.

The saved state is restored the next time you open the same document.

| Host | Where it's stored | Key |
|---|---|---|
| Web | `localStorage` | `urdf-studio:pose:v1` → `{ <folder>:<file-path>: { pose, camera } }` |
| VS Code | `workspaceState` | `urdfStudio.previewState:<uri>` |

## Bookmarks

The **Save As** button captures the current pose + camera under a named
bookmark. The dropdown on the left of Save Pose lists every bookmark; pick
one to apply it.

| Host | Where it's stored | Key |
|---|---|---|
| Web | `localStorage` | `urdf-studio:bookmarks:v1` → `{ <folder>:<file-path>: [ { name, pose, camera, createdAt }, … ] }` |
| VS Code | `workspaceState` | `urdfStudio.bookmarks:<uri>` |

Bookmark names are unique per-document. Saving a name that already exists
overwrites the previous bookmark.

In VS Code you can also delete and rename bookmarks by editing
`workspaceState` via the dev tools — there is no dedicated UI yet.

## Semantic states (SRDF)

If the loaded SRDF declares `<group_state name="ready" group="arm">`
blocks, they appear in the same bookmark dropdown, prefixed with the
group name. These are read-only — applying one sets the joint values it
declares without modifying the SRDF.

## Export Pose

**Export Pose** writes a JSON document:

```json
{
  "source": "/franka_description/robots/fr3/fr3.urdf.xacro",
  "exportedAt": "2025-04-15T10:32:11.123Z",
  "pose": {
    "fr3_joint1": 0.0,
    "fr3_joint2": 0.6,
    ...
  },
  "camera": {
    "position": [3.21, -4.18, 2.55],
    "target":   [0.12, 0.04, 0.41],
    "up":       [0, 0, 1]
  }
}
```

| Host | Where it goes |
|---|---|
| Web | Downloaded as `<urdf-name>-pose.json`. |
| VS Code | Opened as a new JSON document next to the URDF. |

## Capture Screenshot

**Capture Screenshot** writes a PNG of the current viewport at native
resolution. Useful for documentation, PRs, or annotation.

| Host | Where it goes |
|---|---|
| Web | Downloaded as `<urdf-name>-<timestamp>.png`. |
| VS Code | Saved into a `urdf-studio-screenshots/` folder at the workspace root. |

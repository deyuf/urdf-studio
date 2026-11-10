---
title: Save poses and export
order: 80
summary: Save the current pose and camera, keep named bookmarks, and export images, joint values, a parts list or a PDF report.
---

# Save poses and export

## Save the pose you're looking at

Click **Save Pose** in the toolbar. The joint values and camera view are
remembered for this robot file and restored the next time you open it.

## Keep several named poses

Open **Bookmarks** in the toolbar, type a name under **Name this view**
and press **Enter**. The current pose and camera are saved under that
name. Click a bookmark in the list to return to it; hover it and click **×**
to delete it. Saving with an existing name replaces that bookmark.

Bookmarks belong to one robot file. Opening another file shows its own
bookmarks.

| Where | Saved poses and bookmarks are kept in |
|---|---|
| Browser | This browser on this computer. Clearing site data removes them. |
| VS Code | The workspace. |

To share a pose with someone else, export it as JSON (below).

## Export

The **Export** menu in the toolbar has four formats.

| Export | Contains | Good for |
|---|---|---|
| Viewport image · PNG | The 3D view without any interface | Slides, docs, pull requests |
| Joint pose · JSON | Every joint value plus the camera | Sharing a pose, scripting |
| Parts list · CSV | One row per link: parent joint, mass, centre of mass, inertia | Checking masses and inertias in a spreadsheet |
| Inspection report · PDF | Robot name and source, link and joint counts, a screenshot, and the Checks list | Design reviews, handing a model over |

For images at a higher resolution, use **Tools → Screenshot** and choose
a **Scale** of 2× to 4×. **Copy** puts the image on the clipboard instead
of saving a file.

### Where exports go

| Export | Browser | VS Code |
|---|---|---|
| PNG | Downloaded | `urdf-studio-screenshots/` in the workspace |
| JSON | Downloaded | Opened as a new, unsaved document |
| CSV, PDF | Downloaded | Save dialog |

### The pose file

```json
{
  "source": "franka_description/robots/fr3/fr3.urdf.xacro",
  "exportedAt": "2026-11-09T10:32:11.123Z",
  "pose": {
    "fr3_joint1": 0,
    "fr3_joint2": 0.5,
    "fr3_joint4": -1.2
  },
  "camera": {
    "position": [1.8, -1.6, 1.2],
    "target": [0, 0, 0.4],
    "up": [0, 0, 1]
  }
}
```

Joint values are in radians for rotating joints and metres for sliding
ones.

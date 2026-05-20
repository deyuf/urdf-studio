---
title: Render modes
order: 20
---

# Render modes

Switch between three geometry layers from the toolbar:

| Mode | What you see |
|---|---|
| **Visual** | Only the `<visual>` meshes declared on each link. The default. |
| **Collision** | Only the `<collision>` geometry — usually a simplified hull, primitives (capsules, boxes, cylinders), or a low-poly STL. |
| **Both** | Both layers overlaid. Collision geometry is rendered semi-transparent so the visual mesh stays legible. |

## When the collision layer loads

To keep cold-start fast, URDF Studio loads visual meshes first. The
collision layer is loaded lazily the first time you switch to `Collision`
or `Both`. The reload preserves the current pose and camera — there's no
visible interruption other than a "Loading collision geometry…" status
line.

Subsequent toggles between modes are instant since both layers are
already in the scene.

## Wireframe

The **Wire** checkbox turns on wireframe rendering for every mesh in the
scene, regardless of mode. Useful for spotting:

- Cracks or gaps between meshes in adjacent links.
- High-poly meshes that could be decimated for collision.
- Inverted normals (you can see through them).

## Default render mode

Set the mode used on first load:

- **Web:** Settings → Default render mode.
- **VS Code:** `urdfStudio.defaultRenderMode` setting.

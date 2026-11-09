---
title: Navigate the 3D view
order: 10
summary: Orbit, pan and zoom around a robot model, use camera presets, and change the grid, axes and up direction.
---

# Navigate the 3D view

## Moving the camera

| Do this | To |
|---|---|
| Drag | Orbit around the robot |
| Right-drag | Pan |
| Scroll | Zoom in and out |
| Click a part of the robot | Select that link and show it in the Inspector |
| Click empty space | Clear the selection |

Scrolling over the 3D view never scrolls the page around it.

## Camera presets

The bar in the top-left corner of the view has:

- **Fit** — frame the whole robot from an angle. Use this whenever you lose
  the robot.
- **Front**, **Right**, **Top**, **Iso** — look along a fixed direction,
  still framing the whole robot.

## Display options

Open **Display** in the same bar:

| Option | What it does |
|---|---|
| Wire | Draw every mesh as a wireframe. Useful for gaps between parts or heavy meshes. |
| Grid | Show the ground grid. |
| Axes | Show the world X (red), Y (green) and Z (blue) axes at the origin. |
| Frames | Show each link's coordinate frame — see [Frames, labels and inertia](./overlays.html). |
| Inertia | Show centres of mass and inertia ellipsoids. |
| Self-collision | Highlight links whose collision shapes overlap — see [Visual and collision geometry](./render-modes.html#self-collision). |
| Labels | Write joint or link names in the 3D view. |

The **Visual** menu next to the presets switches between visual geometry,
collision geometry, or both.

## The robot is lying on its side

ROS uses Z as up, and so does URDF Studio by default. If your model was
built for a Y-up tool, change **Up axis** in the settings — see
[Packages, xacro args and settings](./settings.html).

## Resizing the side panel

Drag the left edge of the side panel. With the edge focused, the **←** and
**→** keys resize it in steps and **Home** resets it. The width is
remembered.

## The caption in the corner

The small caption at the bottom-left of the view shows what is happening —
parsing, loading meshes — and then the robot's name with its link and
movable joint counts.

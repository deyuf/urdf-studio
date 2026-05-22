---
title: Viewport & navigation
order: 10
---

# Viewport & navigation

A full Three.js viewport with orbit controls, preset cameras, and a
configurable up axis.

## Mouse controls

| Action | Effect |
|---|---|
| Left-drag | Orbit around the focus point. |
| Right-drag | Pan the focus point in screen space. |
| Scroll wheel | Dolly zoom toward/away from the focus point. |
| Click on a link | Selects that link and opens the Inspector tab. |

Wheel events are captured (with `preventDefault` + `stopPropagation` after
the OrbitControls handler) so they never scroll the surrounding page or
the VS Code outer panel.

## Toolbar — view group

| Control | Effect |
|---|---|
| **Fit** | Frame the entire robot at iso angle. |
| **Front / Right / Top / Iso** | Snap to the corresponding preset camera. |

Both Fit and the presets adjust the dolly distance from the robot's
bounding sphere so the model fills the viewport without clipping.

## Toolbar — display group

| Control | Effect |
|---|---|
| **Render mode** | `Visual`, `Collision`, `Both` — see [Render modes](./render-modes.html). |
| **Wire** | Wireframe overlay applied to every mesh. |
| **Grid** | Show or hide the ground plane grid. |
| **Axes** | Show or hide the world XYZ axes helper at the origin. |

## Up axis

The world's up axis is configurable to `+X`, `+Y`, or `+Z`. The grid plane,
camera defaults, and orbit controls all adjust automatically. The default
is `+Z`, matching most ROS conventions.

- **Web:** Settings → Up axis.
- **VS Code:** `urdfStudio.upAxis` setting.

## Status HUD

The bottom-left HUD shows the current parse / load state and, after the
robot is ready, a one-line summary (robot name, link/movable joint count).
It auto-fades after a few seconds and re-appears on any new status event.

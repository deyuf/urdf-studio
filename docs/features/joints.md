---
title: Joint controls
order: 40
---

# Joint controls

The **Joints** tab lists every movable joint in the URDF with a slider
and a numeric input.

## Supported joint types

| Type | Slider behavior |
|---|---|
| `revolute` | Slider range = `<limit lower>` to `<limit upper>` (radians). |
| `continuous` | Slider range = `-π` to `π`. No hard stops on the joint itself. |
| `prismatic` | Slider range = `<limit lower>` to `<limit upper>` (meters). |
| `floating`, `planar` | Slider shown but axis-specific manipulation is limited; this is intentional — these joints have multiple DoFs and aren't meaningfully driven from a single slider. |
| `fixed` | Excluded from the panel. |

The slider and numeric input are bound to the same value. The numeric
input accepts up to 3 decimal places (`step="0.001"`).

## Mimic joints

A joint with a `<mimic joint="other" multiplier="m" offset="o"/>` block is
**not** shown as an independent slider. Instead:

- Its value is computed as `m * value(other) + o`.
- It is hidden from the Joints panel and from the movable joint count.
- Its joint limits (which often default to `[0, 0]` when unset) are
  ignored — the propagated value passes through unclamped.
- It does show up in the Inspector as a regular joint, with a "mimics
  `other`" annotation.

A diagnostic is raised if the master joint name does not exist.

## Ignore limits

The toolbar **Ignore limits** checkbox temporarily disables the URDF
loader's clamp on every movable joint. Useful for:

- Exploring the full physical range of a continuous-but-bounded joint.
- Sanity-checking what poses are geometrically possible vs. what the URDF
  permits.
- Debugging a URDF whose limits look suspect.

The state is **not** persisted; switching robots resets it to off.

## Search and filter

Above the joint list:

- **Search box** — substring match against joint names. Live filter.
- **Only modified** — show only joints whose current value differs from
  the URDF default. Useful when posing many-joint robots.

## Reset to defaults

Each joint's numeric input has a small reset affordance (double-click the
input) that snaps the joint back to its declared default (or `0` if no
default).

## Bookmarks and named states

If the loaded SRDF declares `<group_state name="ready" group="arm">…`
blocks, they appear in the **Bookmarks** dropdown. Selecting a state
applies its joint values atomically. See
[Pose, bookmarks, export](./poses.html).

---
title: Pose the robot
order: 40
summary: Move joints with sliders or exact values, explore beyond limits, use mimic joints and SRDF named states, and change xacro parameters.
---

# Pose the robot

The **Joints** tab lists every joint that can move. When an SRDF is
loaded, joints are grouped by its planning groups.

![The Joints tab with a slider and value for each joint](../images/joints.png)

## Move a joint

- **Drag the slider** to move the joint and watch the robot follow.
- **Type a value** in the number field for an exact position. Revolute and
  continuous joints are in radians (`rad`), prismatic joints in metres
  (`m`).

The slider covers the range in the joint's `<limit>`. Continuous joints go
from −π to π.

Fixed joints are not listed because they can't move.

## Find a joint

On robots with many joints:

- Type in **Filter joints** to show only joints whose name contains that
  text.
- Tick **Modified only** to show only joints you have moved away from
  zero.

## Go past the limits

Tick **Ignore limits** to move joints outside their `<limit>` range. It's
useful to see what the hardware could physically do, or to check whether a
limit is set wrongly. It turns off again when you open another robot.

## Mimic joints

A joint with `<mimic joint="…" multiplier="…" offset="…"/>` follows another
joint, as grippers often do. It has no slider of its own: move the joint
it follows, and it moves too, by `multiplier × value + offset`.

If a mimic points at a joint that doesn't exist, it shows up in
[Checks](./diagnostics.html) as `R-005`.

## Named states from SRDF

If the package has an SRDF with `<group_state>` entries — `ready`, `home`,
`transport` and so on — each group shows them as buttons above its joints.
Click one to apply that pose.

URDF Studio looks for `.srdf` files and `initial_positions.yaml` in each
package's `config/` folder. To use other files, add them under
**Semantic files** in [settings](./settings.html).

## Change xacro parameters

For a `.xacro` file, **Xacro parameters** at the top of the Joints tab
lists the file's `xacro:arg` values — for example which hand is attached,
or the robot's name prefix. Change values and click **Reload xacro**.

To use the same values every time, set **Default xacro args** in
[settings](./settings.html).

## Keep a pose

Click **Save Pose** in the toolbar to keep the current pose, or **Save
As** to keep it under a name. See [Save poses and export](./poses.html).

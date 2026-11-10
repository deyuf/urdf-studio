---
title: Measure, reach and collision pairs
order: 70
summary: Measure distances on the robot, sample the reachable workspace of a link, and find never-colliding link pairs for an SRDF disable_collisions list.
---

# Measure, reach and collision pairs

These tools are in the **Tools** tab.

## Measure a distance

1. Click **Start measuring**.
2. Click two points on the robot.

The Tools tab shows the straight-line distance in metres, the X, Y and Z
differences, and both points' world coordinates. A line is drawn between
the points in the 3D view. Click **Clear** to remove it, or **Start
measuring** again for a new measurement.

Points snap to mesh surfaces, so you can only measure between parts of the
robot, not to empty space.

## See how far the robot reaches

Reachability samples many random joint positions and marks where one link
ends up each time. The resulting point cloud is a picture of the robot's
workspace.

1. Choose the **Tip link**. The list shows links at the end of a chain
   that the joints actually move, with tool points (`tcp`, `tool`, `ee`,
   `flange`…) and the end of the longest moving chain first — so the default
   is normally right.
2. Set the number of **Samples**. 1,000 gives a quick outline; 10,000 or
   more fills the volume in.
3. Click **Sample**. The robot returns to its current pose afterwards.

Points are coloured by height, and the Tools tab shows the X, Y and Z
extent of the cloud. **Clear** removes it. Samples stay within joint
limits. Useful for
comparing robot variants, checking a limit change, or seeing whether a
fixture is within reach.

## Collision pairs

MoveIt and other planners skip checking link pairs listed under
`<disable_collisions>` in the SRDF. Listing pairs that can never touch
makes planning much faster. This tool finds candidates for you.

1. Make sure collision geometry is loaded: switch the view to **Collision**
   or **Both** once.
2. Set **Random poses** — more poses means more confidence. 1,000 is a
   reasonable start; use 10,000 before relying on the result.
3. Click **Analyze**. The tool reports how many of the possible link pairs
   never touched in any sampled pose, and lists them. Links attached
   directly to each other are left out, and so are links with no collision
   geometry (sensor frames, tool points), which can't collide at all.
4. Click **Write to SRDF** to add them.

| Where | What Write to SRDF does |
|---|---|
| Browser | Downloads an updated copy of your SRDF (or a new `<robot>.srdf`) |
| VS Code | Adds the pairs to your SRDF in place, or asks where to create one |

Pairs already in the SRDF are not added twice.

> "Never touched in N random poses" is strong evidence, not proof. Review
> the list for pairs you know can meet — for example a gripper and the
> base of a folding arm.

## Screenshot and export

The **Screenshot** and **Export** sections here do the same as the
toolbar's **Export** menu. See [Save poses and export](./poses.html).

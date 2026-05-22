---
title: Tools
order: 70
---

# Tools

The **Tools** tab hosts compute-heavy actions that operate on the full
joint space.

## Reachability sampling

Generates a workspace point cloud by sampling random joint configurations
and recording the world position of a chosen "tip" link.

### Controls

| Control | Effect |
|---|---|
| **Tip link** | The link whose world position is sampled. Defaults to the leaf link of the longest kinematic chain. |
| **Samples** | Number of poses to sample (typical range: 1k – 100k). |
| **Respect limits** | If on, samples obey `<limit>` bounds. If off, uses `[-π, π]` (revolute/continuous) and `[-1, 1]` (prismatic). |
| **Sample** | Run the sampler. |
| **Clear** | Remove the point cloud from the scene. |

### Behavior

- The sampling runs in chunks via `requestIdleCallback` so the UI stays
  responsive. The current pose is restored after sampling.
- Points are rendered as a `THREE.Points` with a tiny disc material.
- Mimic joints follow their master automatically.

### Use cases

- Compare reach envelopes between robot variants.
- Visualize the impact of changing a joint limit.
- Find where a fixture must be placed for the robot to reach it.

## Never-colliding pair detection

Monte-Carlo samples joint configurations to find link pairs that **never
collide** in any sampled pose. Output is the candidate set of
`<disable_collisions>` entries to drop into an SRDF.

### Controls

| Control | Effect |
|---|---|
| **Samples** | Number of poses to evaluate. More samples = stronger evidence of "never collides". |
| **Run** | Start sampling. Disabled until collision geometry is loaded. |
| **Write SRDF** | Merge the detected pairs into the workspace SRDF (or a new one). |

### Output

- A list of link pairs that did not collide in any sampled pose,
  presented compactly (first 200 with an overflow counter).
- A summary line: `N never-colliding pairs found from M samples.`
- A **Write SRDF** button that triggers a download (web) or an in-place
  write (VS Code) with merged `<disable_collisions>` entries.

### How it samples

The sampler uses the loaded collision meshes (preferring primitives; STL
where needed) and checks pairwise BVH overlap (via `three-mesh-bvh`).
Pairs that are directly connected by a joint are excluded — they share a
collision boundary by construction.

### Limitations

- "Never collides in N samples" is statistical evidence, not proof.
  Increase samples for higher confidence.
- Only meshes / primitives declared as `<collision>` are tested. Self-
  collision capsules without collision geometry are skipped.

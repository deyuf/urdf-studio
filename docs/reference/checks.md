---
title: Checks
order: 10
summary: Every check URDF Studio runs on a robot model — what triggers it, its severity, and how to fix it.
---

# Checks reference

The codes below appear in the **Checks** tab. The first letter says what
kind of problem it is:

- **R** — robot structure (the link tree)
- **P** — physical properties (mass, inertia, limits)
- **A** — assets (mesh files and packages)
- **S** — xacro style

For how to use the Checks tab, see
[Find and fix problems](../features/diagnostics.html).

## Structure

| Code | Severity | Found when | How to fix |
|---|---|---|---|
| `R-001` | Error | There is no root link, or several unconnected trees each have children | Connect every link to one tree with joints |
| `R-002` | Error | Following joints from parent to child comes back to the same link | Remove or redirect the joint that closes the loop |
| `R-003` | Error | A joint's `parent` or `child` names a link that doesn't exist | Fix the typo, or declare the missing link |
| `R-004` | Error | Two links, or two joints, have the same name | Rename one; in xacro, check that prefixes are applied |
| `R-005` | Error | A `<mimic>` names a joint that doesn't exist, or mimics form a loop | Point the mimic at an existing, non-mimic joint |

## Physical properties

| Code | Severity | Found when | How to fix |
|---|---|---|---|
| `P-001` | Warning | A link has no `<inertial>` | Add mass and inertia. Fine to ignore for pure frames like `tool0`. Not checked for MuJoCo models, which compute inertia from geoms |
| `P-002` | Warning | The inertia values are physically impossible (the tensor is not positive-definite) | Recompute the inertia, for example from the CAD model. Check `ixx`, `iyy`, `izz` are positive and each is less than the sum of the other two |
| `P-003` | Error / Warning | Mass is negative (error), zero or missing (warning), or over 10,000 kg (warning — usually grams used by mistake) | Give every real part its mass in kilograms |
| `P-004` | Warning | A revolute or prismatic joint has no lower or upper limit | Add `<limit lower upper effort velocity>` |
| `P-005` | Warning | A continuous joint declares `lower` / `upper` | Remove them (they're ignored), or make the joint revolute |
| `P-006` | Warning | A joint's `effort` or `velocity` limit is zero | Set the real values; controllers may refuse to move the joint otherwise |

## Assets

| Code | Severity | Found when | How to fix |
|---|---|---|---|
| `A-001` | Error | A mesh file can't be found, a `package://` path names a package that isn't in the opened folder, or has no package name | See [Meshes are missing](../help/#meshes-are-missing) |
| `A-002` | Warning | A package has no `package.xml` in the opened folder, but its meshes were found by looking in parent folders | Open the folder that contains `package.xml` |
| `A-003` | Info | Some meshes are scaled by 0.001 or 1000 and others aren't — a sign of mixed millimetres and metres | Check each mesh's units; URDF uses metres |

## Xacro style

These only apply to `.xacro` files.

| Code | Severity | Found when | How to fix |
|---|---|---|---|
| `S-001` | Info | `$(arg name)` is used without a matching `<xacro:arg>` | Declare the argument with a default |
| `S-002` | Info | A `<xacro:property>` or `<xacro:arg>` is declared but never used | Remove it, or check for a typo where it should be used |
| `S-003` | Info | A `<xacro:macro>` is declared but never called | Remove it, or call it |
| `S-004` | Warning | An expression divides by zero | Fix the expression or the property it uses |
| `S-005` | Info | A link or joint name isn't `snake_case` | Off by default |

## Loading problems

Some problems stop the model from loading properly. They are listed
together under **Loading problems** in the Checks tab, also pop up as a
message in the corner of the window, and appear in the Problems panel in
VS Code:

| Message is about | Meaning |
|---|---|
| XML that can't be parsed | The file isn't valid XML — often an unclosed tag or a stray `&`. Nothing can be shown until it's fixed |
| Xacro that can't be expanded | An include, macro call or argument failed. The message names it |
| An include cycle | Two xacro files include each other (or a file includes itself) |
| A macro that calls itself too deeply | A recursive macro has no stopping condition (limit: 200 levels) |
| A file that isn't valid XML | The robot file or an included file is empty or not XML |
| A skipped xacro expression | One `${…}` expression failed; the rest of the file was expanded without it |
| `$(find pkg)` for an unknown package | The package isn't in the opened folder or [package roots](../features/settings.html) |
| A link with more than one parent | Two joints name the same `child` |
| `lower` greater than `upper` | A joint's limits are reversed |
| SRDF or semantic files | A configured SRDF or YAML file couldn't be read or parsed |

## Quick fixes

| Check | Fix |
|---|---|
| `P-001` | Inserts a small default `<inertial>` |
| `P-003` | Sets the mass to 1.0 |
| `P-004` | Inserts a default `<limit>` |
| `P-005` | Removes the limits from the continuous joint |
| `P-006` | Sets effort to 100 and velocity to 1.0 |

The inserted values are placeholders. Replace them with real numbers.

## Health score

Model health = 100 − 10 × errors − 3 × warnings − 0.5 × infos, never below
zero.

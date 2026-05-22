---
title: Diagnostics
order: 60
---

# Diagnostics (Checks panel)

The **Checks** tab is the unified view of every problem the parser and
analyzer found in the current model. In the VS Code build the same items
also appear in the Problems panel with line numbers.

Each diagnostic has a severity (`error` / `warning` / `info`), a stable
code, an optional file/line, and a human message.

## XML / xacro

| Code | Severity | Triggered by |
|---|---|---|
| `xml.parse` | error | The XML is malformed at the byte level. The URDF cannot be loaded. |
| `xacro.expand` | error | Xacro expansion failed and no recovery was possible. The pre-expansion text is shown instead. |
| `xacro.expressionSkipped` | warning | An expression failed to evaluate; URDF Studio retried with the offending expression elided so the rest of the file could still be expanded. |
| `xacro.packageMissing` | warning | `$(find pkg)` was called with a package name not in the discovered map. The substitution returns `/unknown-package` so expansion can continue. |

## Tree structure

| Code | Severity | Triggered by |
|---|---|---|
| `link.missingName` | error | A `<link>` element without a `name` attribute. |
| `link.duplicate` | error | Two `<link>` elements share the same name. |
| `joint.missingName` | error | A `<joint>` element without a `name` attribute. |
| `joint.duplicate` | error | Two `<joint>` elements share the same name. |
| `joint.parentMissing` | error | Joint references a parent link that does not exist. |
| `joint.childMissing` | error | Joint references a child link that does not exist. |
| `tree.multipleParents` | error | A link is named as the child of more than one joint. |
| `tree.cycle` | error | A cycle was detected in the link tree (DFS). |
| `tree.rootCount` | warning | Expected one root link; found zero or many. |

## Joints

| Code | Severity | Triggered by |
|---|---|---|
| `joint.limitMissing` | warning | A `revolute` or `prismatic` joint has no `<limit lower>` / `<limit upper>`. |
| `joint.limitInvalid` | error | `lower > upper` on a `<limit>` element. |
| `joint.mimicMissing` | warning | `<mimic joint="other">` references a joint that does not exist. |

## Meshes

| Code | Severity | Triggered by |
|---|---|---|
| `mesh.packageMalformed` | error | A `package://` URI without a package name. |
| `mesh.packageMissing` | error | A `package://` URI references a package not found in the workspace / folder. |
| `mesh.missing` | error | The resolved mesh path does not exist on disk. The link still shows; just without that particular mesh. |

## Inertial

| Code | Severity | Triggered by |
|---|---|---|
| `inertial.massInvalid` | warning | `<mass value>` is missing, zero, or negative. |
| `inertial.tensorMissing` | warning | `<inertial>` block without an `<inertia>` tensor. |
| `inertial.notPositiveDefinite` | warning | Eigenvalues of the inertia tensor are not all strictly positive. Either the link can't physically rotate that way, or the URDF is wrong. |

## Semantic (SRDF)

| Code | Severity | Triggered by |
|---|---|---|
| `srdf.parse` | error | The SRDF file is malformed XML. |
| `srdf.groupMissingName` | warning | A `<group>` element without `name`. Skipped. |
| `srdf.groupMissing` | warning | A `<group>` references a subgroup that does not exist. |
| `srdf.groupCycle` | warning | Cycle in group inheritance. The branch is ignored. |
| `srdf.stateInvalid` | warning | A `<group_state>` without `name` or `group`. |
| `semantic.readFailed` | warning | Configured semantic file could not be read. |
| `semantic.yamlParse` | warning | YAML semantic file did not parse. |

## Preview

| Code | Severity | Triggered by |
|---|---|---|
| `preview.loadFailed` | error | The preview pipeline threw an exception not classified above. |

## What to do with them

- Errors typically prevent something visible from working (a link won't
  render, a mesh won't load). Fix the URDF.
- Warnings are usually fine but worth a second look — they often catch
  copy-paste mistakes in xacro macros or mesh paths.
- The `xacro.expressionSkipped` category in particular is forgiving: the
  rest of the file expands fine, you just get a noticeable hole where the
  bad expression was. Search the file for the expression text to find it.

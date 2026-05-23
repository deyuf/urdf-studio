// URDF / xacro autocompletion source.
//
// Three kinds of completions are produced, depending on what the cursor
// sees just before it:
//
//   1. Schema completions — fixed list of URDF / xacro element & attribute
//      names. Driven entirely by `urdfSchema` below.
//   2. Semantic completions — the link/joint names currently declared
//      in the document. Provided by the renderer through the
//      CompletionContextProvider (it has the live metadata).
//   3. Enum completions — joint type, render mode, axis presets etc.
//
// The schema list is hand-curated (not generated from XSD) so we can write
// short, expressive snippets and pick sensible default attribute order.

import { autocompletion, type CompletionContext, type CompletionResult, type Completion } from '@codemirror/autocomplete';
import { snippetCompletion } from '@codemirror/autocomplete';

export interface CompletionContextProvider {
  /** All declared link names in the current document. */
  linkNames(): string[];
  /** All declared joint names. */
  jointNames(): string[];
  /** All declared movable joint names (revolute / prismatic / continuous / planar / floating). */
  movableJointNames(): string[];
  /** Package names visible to the host (from packageMap). */
  packageNames(): string[];
}

const JOINT_TYPES: Completion[] = [
  { label: 'fixed', type: 'enum', detail: 'no DoF' },
  { label: 'revolute', type: 'enum', detail: 'rotation with limits' },
  { label: 'continuous', type: 'enum', detail: 'free rotation' },
  { label: 'prismatic', type: 'enum', detail: 'translation with limits' },
  { label: 'floating', type: 'enum', detail: '6-DoF' },
  { label: 'planar', type: 'enum', detail: 'in-plane translation + yaw' }
];

const URDF_SCHEMA_SNIPPETS: Completion[] = [
  snippetCompletion('<link name="${name}">\n  <visual>\n    <geometry>\n      <box size="${0.1 0.1 0.1}"/>\n    </geometry>\n  </visual>\n</link>', {
    label: 'link', type: 'class', detail: 'URDF link', boost: 99
  }),
  snippetCompletion('<joint name="${name}" type="${revolute}">\n  <parent link="${parent}"/>\n  <child link="${child}"/>\n  <axis xyz="${0 0 1}"/>\n  <limit lower="${-1.57}" upper="${1.57}" effort="${100}" velocity="${1.0}"/>\n</joint>', {
    label: 'joint', type: 'class', detail: 'URDF joint', boost: 99
  }),
  snippetCompletion('<inertial>\n  <mass value="${1.0}"/>\n  <inertia ixx="${0.01}" ixy="0" ixz="0" iyy="${0.01}" iyz="0" izz="${0.01}"/>\n</inertial>', {
    label: 'inertial', type: 'class', detail: 'mass + inertia tensor'
  }),
  snippetCompletion('<visual>\n  <geometry>\n    <${box size="0.1 0.1 0.1"}/>\n  </geometry>\n</visual>', {
    label: 'visual', type: 'class'
  }),
  snippetCompletion('<collision>\n  <geometry>\n    <${box size="0.1 0.1 0.1"}/>\n  </geometry>\n</collision>', {
    label: 'collision', type: 'class'
  }),
  snippetCompletion('<origin xyz="${0 0 0}" rpy="${0 0 0}"/>', { label: 'origin', type: 'property' }),
  snippetCompletion('<axis xyz="${0 0 1}"/>', { label: 'axis', type: 'property' }),
  snippetCompletion('<limit lower="${-1.57}" upper="${1.57}" effort="${100}" velocity="${1.0}"/>', {
    label: 'limit', type: 'property'
  }),
  snippetCompletion('<mimic joint="${joint}" multiplier="${1.0}" offset="${0}"/>', { label: 'mimic', type: 'property' }),
  snippetCompletion('<dynamics damping="${0.1}" friction="${0}"/>', { label: 'dynamics', type: 'property' }),
  snippetCompletion('<mesh filename="${path}" scale="1 1 1"/>', { label: 'mesh', type: 'property' }),
  snippetCompletion('<box size="${0.1 0.1 0.1}"/>', { label: 'box', type: 'property' }),
  snippetCompletion('<cylinder radius="${0.05}" length="${0.1}"/>', { label: 'cylinder', type: 'property' }),
  snippetCompletion('<sphere radius="${0.05}"/>', { label: 'sphere', type: 'property' })
];

const XACRO_SNIPPETS: Completion[] = [
  snippetCompletion('<xacro:arg name="${name}" default="${value}"/>', { label: 'xacro:arg', type: 'keyword', boost: 90 }),
  snippetCompletion('<xacro:property name="${name}" value="${value}"/>', { label: 'xacro:property', type: 'keyword', boost: 90 }),
  snippetCompletion('<xacro:macro name="${name}" params="${params}">\n  ${body}\n</xacro:macro>', { label: 'xacro:macro', type: 'keyword', boost: 90 }),
  snippetCompletion('<xacro:include filename="${path}"/>', { label: 'xacro:include', type: 'keyword', boost: 90 }),
  snippetCompletion('<xacro:if value="${condition}">\n  ${body}\n</xacro:if>', { label: 'xacro:if', type: 'keyword' }),
  snippetCompletion('<xacro:unless value="${condition}">\n  ${body}\n</xacro:unless>', { label: 'xacro:unless', type: 'keyword' })
];

export function urdfCompletionSource(
  provider: CompletionContextProvider,
  format: 'urdf' | 'xacro'
) {
  return (context: CompletionContext): CompletionResult | null => {
    const text = context.state.doc.toString();
    const cursor = context.pos;
    const before = text.slice(Math.max(0, cursor - 200), cursor);

    // 1. Attribute-value contexts. Look for: parent link="...|", child link="...|",
    //    mimic joint="...|", type="...|", or filename="package://...|".
    const linkAttrMatch = /<(parent|child)\s+link="([^"]*)$/.exec(before);
    if (linkAttrMatch) {
      const partial = linkAttrMatch[2];
      const from = cursor - partial.length;
      return makeLinkResult(provider, from);
    }

    const mimicAttrMatch = /<mimic\s+joint="([^"]*)$/.exec(before);
    if (mimicAttrMatch) {
      const partial = mimicAttrMatch[1];
      const from = cursor - partial.length;
      return makeJointResult(provider, from);
    }

    const typeAttrMatch = /<joint\b[^>]*\btype="([^"]*)$/.exec(before);
    if (typeAttrMatch) {
      const partial = typeAttrMatch[1];
      const from = cursor - partial.length;
      return {
        from,
        options: JOINT_TYPES,
        validFor: /^[\w]*$/
      };
    }

    const packageMatch = /filename="package:\/\/([^"/]*)$/.exec(before);
    if (packageMatch) {
      const partial = packageMatch[1];
      const from = cursor - partial.length;
      return {
        from,
        options: provider.packageNames().map(name => ({ label: name, type: 'namespace' })),
        validFor: /^[\w-]*$/
      };
    }

    // 2. Tag-name contexts. Trigger when the previous char(s) is `<` and the
    //    cursor is at the tag-name position.
    const tagMatch = /<(xacro:)?([A-Za-z][\w:-]*)?$/.exec(before);
    if (tagMatch) {
      const partial = tagMatch[0].slice(1); // drop the `<`
      const from = cursor - partial.length;
      const options = [
        ...URDF_SCHEMA_SNIPPETS,
        ...(format === 'xacro' ? XACRO_SNIPPETS : [])
      ];
      return {
        from,
        options,
        validFor: /^[\w:-]*$/
      };
    }

    return null;
  };
}

function makeLinkResult(provider: CompletionContextProvider, from: number): CompletionResult {
  const options: Completion[] = provider.linkNames().map(name => ({
    label: name,
    type: 'variable',
    detail: 'link'
  }));
  return { from, options, validFor: /^[\w./-]*$/ };
}

function makeJointResult(provider: CompletionContextProvider, from: number): CompletionResult {
  const options: Completion[] = provider.movableJointNames().map(name => ({
    label: name,
    type: 'function',
    detail: 'movable joint'
  }));
  return { from, options, validFor: /^[\w./-]*$/ };
}

// Convenience: expose the autocompletion extension factory so callers can
// add it directly without thinking about the source signature.
export function urdfAutocomplete(provider: CompletionContextProvider, format: 'urdf' | 'xacro') {
  return autocompletion({
    override: [urdfCompletionSource(provider, format)],
    activateOnTyping: true,
    closeOnBlur: true
  });
}

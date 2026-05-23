// URDF / xacro syntax highlighting layered on top of @codemirror/lang-xml.
//
// The base XML grammar gives us tag / attribute / string tokens. We add
// a second decoration layer (driven by view.update events) that promotes
// recognised URDF structural tags and xacro namespace tags to distinct
// classes so they can be coloured. The CSS lives in editor.css to keep
// the build simple and the theming dependent on VS Code's CSS variables.

import { HighlightStyle, syntaxTree } from '@codemirror/language';
import { Decoration, type DecorationSet, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { RangeSetBuilder } from '@codemirror/state';
import { tags as t } from '@lezer/highlight';

// Base highlight style — applies to the @lezer/xml token types. We pick
// colours that work in both light and dark themes via CSS variables.
export const urdfHighlight = HighlightStyle.define([
  { tag: t.tagName, class: 'cm-urdf-tag' },
  { tag: t.attributeName, class: 'cm-urdf-attr' },
  { tag: t.attributeValue, class: 'cm-urdf-value' },
  { tag: t.string, class: 'cm-urdf-value' },
  { tag: t.number, class: 'cm-urdf-number' },
  { tag: t.comment, class: 'cm-urdf-comment' },
  { tag: t.processingInstruction, class: 'cm-urdf-pi' },
  { tag: t.bracket, class: 'cm-urdf-bracket' },
  { tag: t.angleBracket, class: 'cm-urdf-bracket' }
]);

const URDF_STRUCTURAL = new Set([
  'robot', 'link', 'joint', 'visual', 'collision', 'inertial', 'geometry',
  'parent', 'child', 'origin', 'axis', 'limit', 'mimic', 'safety_controller',
  'calibration', 'dynamics', 'material', 'texture', 'mesh', 'box', 'cylinder',
  'sphere', 'mass', 'inertia', 'transmission'
]);

// Pre-compute which characters in URDF attribute values look like numbers
// so the highlight plugin can recolour them. We don't try to be exact —
// just a hint that helps with reading dense xyz="..." attributes.
const NUMERIC_REGEX = /-?\d+\.?\d*(?:[eE][-+]?\d+)?/g;
const PACKAGE_URI_REGEX = /package:\/\/[^"\s]+/g;
const XACRO_EXPR_REGEX = /\$\{[^}]+\}|\$\([^)]+\)/g;

class UrdfHighlightPlugin {
  decorations: DecorationSet;

  constructor(view: EditorView) {
    this.decorations = this.build(view);
  }

  update(update: ViewUpdate): void {
    if (update.docChanged || update.viewportChanged) {
      this.decorations = this.build(update.view);
    }
  }

  private build(view: EditorView): DecorationSet {
    const builder = new RangeSetBuilder<Decoration>();
    // First pass: walk the lezer tree for the visible viewport and tag
    // structural elements.
    for (const { from, to } of view.visibleRanges) {
      const tree = syntaxTree(view.state);
      tree.iterate({
        from, to,
        enter: node => {
          if (node.name === 'TagName' || node.name === 'StartTag' || node.name === 'EndTag') {
            const text = view.state.doc.sliceString(node.from, node.to);
            const bareName = text.replace(/^<\/?/, '').trim();
            if (bareName.startsWith('xacro:')) {
              builder.add(node.from, node.to, Decoration.mark({ class: 'cm-urdf-xacro' }));
            } else if (URDF_STRUCTURAL.has(bareName)) {
              builder.add(node.from, node.to, Decoration.mark({ class: 'cm-urdf-structural' }));
            }
          }
        }
      });

      // Second pass: scan attribute-value strings inside the viewport for
      // numbers, package:// URIs and xacro expressions. Cheap: O(viewport
      // chars) regex.
      const text = view.state.doc.sliceString(from, to);
      const stringRegex = /"([^"]*)"/g;
      let stringMatch: RegExpExecArray | null;
      while ((stringMatch = stringRegex.exec(text)) !== null) {
        const stringStart = from + stringMatch.index + 1;
        const inner = stringMatch[1];

        scanRegex(inner, PACKAGE_URI_REGEX, (start, end) => {
          builder.add(stringStart + start, stringStart + end, Decoration.mark({ class: 'cm-urdf-package' }));
        });
        scanRegex(inner, XACRO_EXPR_REGEX, (start, end) => {
          builder.add(stringStart + start, stringStart + end, Decoration.mark({ class: 'cm-urdf-expr' }));
        });
      }
    }
    return builder.finish();
  }
}

function scanRegex(haystack: string, regex: RegExp, push: (start: number, end: number) => void): void {
  regex.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(haystack)) !== null) {
    push(match.index, match.index + match[0].length);
    if (match.index === regex.lastIndex) {
      regex.lastIndex += 1;
    }
  }
}

// Note: we intentionally do NOT export the number regex scanner as a
// plugin — embedding numeric highlighting inside the existing attribute
// value markup produces too many overlapping decorations for very dense
// xyz/inertia strings. Numbers are handled by the base XML highlight via
// the t.number tag where supported.
void NUMERIC_REGEX;

export const urdfStructuralPlugin = ViewPlugin.fromClass(UrdfHighlightPlugin, {
  decorations: instance => instance.decorations
});

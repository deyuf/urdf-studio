// Quick-Fix actions shared between the editor (inline diagnostic actions)
// and the VS Code CodeActionProvider. Each fix is keyed by the rule code.
//
// We deliberately keep the fixes as small, deterministic text edits so
// they are easy to undo and easy to test.

import { EditorView } from '@codemirror/view';
import type { StudioDiagnostic } from '../core/types';

export interface QuickFixRunner {
  /** The renderer side may need to know the user accepted a fix (for telemetry / refresh). */
  notify?(code: string, diag: StudioDiagnostic): void;
}

export interface QuickFix {
  label: string;
  apply(view: EditorView, diag: StudioDiagnostic, runner: QuickFixRunner): void;
}

function findLineForDiagnostic(view: EditorView, diag: StudioDiagnostic): number | undefined {
  if (!diag.line || diag.line < 1) return undefined;
  if (diag.line > view.state.doc.lines) return undefined;
  return diag.line;
}

function indentOf(text: string): string {
  const m = /^(\s*)/.exec(text);
  return m ? m[1] : '';
}

// Resolve where to insert a child element into the <tagName> element that
// starts at (or just after) the diagnostic line. Handles two shapes:
//   <link name="a">...</link>   → insert before the matching </tag>
//   <link name="a"/>            → expand the self-closing tag into a pair
// Returning a description rather than mutating keeps each fix's intent clear
// and avoids the old bug where a self-closing element made the scan land on a
// LATER element's closing tag.
type ElementInsertion =
  | { kind: 'before'; from: number; indent: string }
  | { kind: 'expand'; from: number; to: number; indent: string };

function locateElementInsertion(view: EditorView, startLine: number, tagName: string): ElementInsertion | undefined {
  const doc = view.state.doc;
  // Find the line that opens the element (the diagnostic usually points at it,
  // but be tolerant of a small offset).
  const opener = new RegExp(`<${tagName}\\b`);
  let tagLine = -1;
  for (let i = startLine; i <= Math.min(doc.lines, startLine + 5); i++) {
    if (opener.test(doc.line(i).text)) {
      tagLine = i;
      break;
    }
  }
  if (tagLine === -1) {
    return undefined;
  }
  const tagLineInfo = doc.line(tagLine);
  const tagIndent = indentOf(tagLineInfo.text);
  const tagStartCol = tagLineInfo.text.search(opener);
  const tagStartOffset = tagLineInfo.from + tagStartCol;

  // Scan forward from the tag start to the end of the opening tag, ignoring
  // '>' characters inside quoted attribute values, to learn whether it is
  // self-closing.
  const tail = doc.sliceString(tagStartOffset, doc.length);
  let quote: string | null = null;
  for (let k = 0; k < tail.length; k++) {
    const ch = tail[k];
    if (quote) {
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === '\'') {
      quote = ch;
      continue;
    }
    if (ch === '>') {
      const selfClose = tail[k - 1] === '/';
      if (selfClose) {
        // Replace the trailing "/>" with ">"; the caller's child + close tag
        // follow.
        return { kind: 'expand', from: tagStartOffset + k - 1, to: tagStartOffset + k + 1, indent: tagIndent };
      }
      break; // Open tag with children — fall through to find the close tag.
    }
  }

  // Open/close form: find the matching </tagName>.
  const closer = new RegExp(`</${tagName}\\s*>`);
  for (let i = tagLine; i <= doc.lines; i++) {
    const lineInfo = doc.line(i);
    if (closer.test(lineInfo.text)) {
      return { kind: 'before', from: lineInfo.from, indent: indentOf(lineInfo.text) + '  ' };
    }
  }
  return undefined;
}

// ---- P-004: insert default <limit/> --------------------------------------

const fixInsertLimit: QuickFix = {
  label: 'Insert default <limit>',
  apply(view, diag, runner) {
    const line = findLineForDiagnostic(view, diag);
    if (line === undefined) return;
    const target = locateElementInsertion(view, line, 'joint');
    if (!target) return;
    const limit = (indent: string) => `${indent}<limit lower="-1.57" upper="1.57" effort="100" velocity="1.0"/>`;
    if (target.kind === 'before') {
      view.dispatch({ changes: { from: target.from, insert: `${limit(target.indent)}\n` } });
    } else {
      const childIndent = target.indent + '  ';
      view.dispatch({
        changes: { from: target.from, to: target.to, insert: `>\n${limit(childIndent)}\n${target.indent}</joint>` }
      });
    }
    runner.notify?.('P-004', diag);
  }
};

// ---- P-003: replace negative mass with 1.0 --------------------------------

const fixMass: QuickFix = {
  label: 'Set mass to 1.0',
  apply(view, diag, runner) {
    const line = findLineForDiagnostic(view, diag);
    if (line === undefined) return;
    const doc = view.state.doc;
    // Look at the next ~10 lines for a <mass value="..."/> tag.
    for (let i = line; i <= Math.min(doc.lines, line + 10); i++) {
      const lineInfo = doc.line(i);
      const text = doc.sliceString(lineInfo.from, lineInfo.to);
      const match = /(<mass\s+value=")([^"]*)(")/.exec(text);
      if (match) {
        const start = lineInfo.from + match.index + match[1].length;
        const end = start + match[2].length;
        view.dispatch({ changes: { from: start, to: end, insert: '1.0' } });
        runner.notify?.('P-003', diag);
        return;
      }
    }
  }
};

// ---- P-006: set effort and velocity to reasonable defaults ----------------

const fixEffortVelocity: QuickFix = {
  label: 'Set effort=100, velocity=1.0',
  apply(view, diag, runner) {
    const line = findLineForDiagnostic(view, diag);
    if (line === undefined) return;
    const doc = view.state.doc;
    for (let i = line; i <= Math.min(doc.lines, line + 30); i++) {
      const lineInfo = doc.line(i);
      const text = doc.sliceString(lineInfo.from, lineInfo.to);
      const limitMatch = /<limit\s+([^/>]*)/.exec(text);
      if (limitMatch) {
        const attrs = limitMatch[1]
          .replace(/\beffort="[^"]*"/, 'effort="100"')
          .replace(/\bvelocity="[^"]*"/, 'velocity="1.0"');
        const replacement = `<limit ${attrs}`;
        const startOffset = lineInfo.from + limitMatch.index;
        view.dispatch({
          changes: { from: startOffset, to: startOffset + limitMatch[0].length, insert: replacement }
        });
        runner.notify?.('P-006', diag);
        return;
      }
    }
  }
};

// ---- P-005: drop spurious <limit> from a continuous joint -----------------

const fixDropContinuousLimit: QuickFix = {
  label: 'Remove unused <limit> from continuous joint',
  apply(view, diag, runner) {
    const line = findLineForDiagnostic(view, diag);
    if (line === undefined) return;
    const doc = view.state.doc;
    for (let i = line; i <= Math.min(doc.lines, line + 30); i++) {
      const lineInfo = doc.line(i);
      const text = doc.sliceString(lineInfo.from, lineInfo.to);
      if (/<limit\b/.test(text)) {
        // Drop the whole line — keep behaviour predictable.
        const trailing = i < doc.lines ? '\n' : '';
        view.dispatch({
          changes: { from: lineInfo.from, to: lineInfo.to + trailing.length, insert: '' }
        });
        runner.notify?.('P-005', diag);
        return;
      }
      if (/<\/joint\s*>/.test(text)) {
        return;
      }
    }
  }
};

// ---- P-001: insert an inertial stub --------------------------------------

const fixInsertInertial: QuickFix = {
  label: 'Insert default <inertial>',
  apply(view, diag, runner) {
    const line = findLineForDiagnostic(view, diag);
    if (line === undefined) return;
    const target = locateElementInsertion(view, line, 'link');
    if (!target) return;
    const inertial = (indent: string) =>
      `${indent}<inertial>\n` +
      `${indent}  <mass value="1.0"/>\n` +
      `${indent}  <inertia ixx="0.01" ixy="0" ixz="0" iyy="0.01" iyz="0" izz="0.01"/>\n` +
      `${indent}</inertial>`;
    if (target.kind === 'before') {
      view.dispatch({ changes: { from: target.from, insert: `${inertial(target.indent)}\n` } });
    } else {
      const childIndent = target.indent + '  ';
      view.dispatch({
        changes: { from: target.from, to: target.to, insert: `>\n${inertial(childIndent)}\n${target.indent}</link>` }
      });
    }
    runner.notify?.('P-001', diag);
  }
};

export const QUICK_FIXES: Record<string, QuickFix> = {
  'P-001': fixInsertInertial,
  'P-003': fixMass,
  'P-004': fixInsertLimit,
  'P-005': fixDropContinuousLimit,
  'P-006': fixEffortVelocity
};

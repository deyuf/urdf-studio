// Adapter that takes the renderer's already-computed StudioDiagnostic[]
// and converts it into CodeMirror Diagnostic[] for inline display.
//
// We deliberately do NOT use the linter() factory: that one schedules its
// own setTimeout-based runs which fight against our existing analysis
// loop and create test flakiness (asynchronous CM6 updates firing after
// the test that scheduled them already returned). Instead we expose the
// lintField extension and push diagnostics imperatively via the
// refreshLint() method on the editor handle.

import { type Diagnostic, lintGutter, setDiagnostics } from '@codemirror/lint';
import { Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import type { StudioDiagnostic } from '../core/types';
import { QUICK_FIXES, type QuickFixRunner } from './fixes';

export interface LinterContext {
  /** Return the current diagnostics for the document being edited. */
  getDiagnostics(): StudioDiagnostic[];
  /** Optional Quick-Fix runner — wired into CM6 actions. */
  runQuickFix?: QuickFixRunner;
}

/**
 * Returns the lint-related CM6 extensions: the gutter + a tiny plugin
 * that listens to dispatched effects and re-runs the conversion.
 */
export function urdfLintExtensions(): Extension[] {
  return [lintGutter()];
}

/**
 * Push the latest StudioDiagnostic[] into the editor. Safe to call from
 * outside an active update — the dispatch is queued through CM6's normal
 * transaction system.
 */
export function pushLint(view: EditorView, context: LinterContext): void {
  const diagnostics = translate(view, context);
  view.dispatch(setDiagnostics(view.state, diagnostics));
}

function translate(view: EditorView, context: LinterContext): Diagnostic[] {
  const diagnostics = context.getDiagnostics();
  const doc = view.state.doc;
  const totalLines = doc.lines;
  const out: Diagnostic[] = [];
  for (const diag of diagnostics) {
    const line = clampLine(diag.line, totalLines);
    if (line === undefined) {
      if (totalLines === 0) continue;
      const lineInfo = doc.line(1);
      out.push({
        from: lineInfo.from,
        to: lineInfo.to,
        severity: diag.severity,
        message: format(diag),
        actions: buildActions(diag, context.runQuickFix)
      });
      continue;
    }
    const lineInfo = doc.line(line);
    out.push({
      from: lineInfo.from,
      to: lineInfo.to,
      severity: diag.severity,
      message: format(diag),
      actions: buildActions(diag, context.runQuickFix)
    });
  }
  return out;
}

function clampLine(line: number | undefined, totalLines: number): number | undefined {
  if (line === undefined) return undefined;
  if (totalLines === 0) return undefined;
  return Math.max(1, Math.min(line, totalLines));
}

function format(diag: StudioDiagnostic): string {
  if (diag.code) {
    return `[${diag.code}] ${diag.message}`;
  }
  return diag.message;
}

function buildActions(diag: StudioDiagnostic, runner?: QuickFixRunner): Diagnostic['actions'] {
  if (!runner || !diag.code) return undefined;
  const fix = QUICK_FIXES[diag.code];
  if (!fix) return undefined;
  return [{
    name: fix.label,
    apply: (view, _from, _to) => {
      void _from;
      void _to;
      fix.apply(view, diag, runner);
    }
  }];
}

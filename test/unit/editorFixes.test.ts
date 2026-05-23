// Quick-Fix tests. Each fix is exercised against a known-bad fragment;
// we assert the edit produces the expected text.

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { EditorState, Text } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { JSDOM } from 'jsdom';
import { QUICK_FIXES } from '../../src/editor/fixes';
import type { StudioDiagnostic } from '../../src/core/types';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.HTMLElement = dom.window.HTMLElement;
g.Node = dom.window.Node;
g.Range = dom.window.Range;
g.Element = dom.window.Element;
g.Event = dom.window.Event;
g.MutationObserver = dom.window.MutationObserver;
g.getComputedStyle = dom.window.getComputedStyle.bind(dom.window);
g.requestAnimationFrame = () => 0;
g.cancelAnimationFrame = () => undefined;
(dom.window as unknown as { requestAnimationFrame?: () => number }).requestAnimationFrame = () => 0;
(dom.window as unknown as { cancelAnimationFrame?: () => void }).cancelAnimationFrame = () => undefined;

function makeView(text: string): EditorView {
  const state = EditorState.create({ doc: Text.of(text.split('\n')) });
  const host = dom.window.document.createElement('div');
  dom.window.document.body.appendChild(host);
  return new EditorView({ state, parent: host });
}

function apply(code: string, text: string, diag: Partial<StudioDiagnostic>): string {
  const view = makeView(text);
  const full: StudioDiagnostic = { severity: 'warning', message: '', code, ...diag };
  QUICK_FIXES[code]!.apply(view, full, {});
  const result = view.state.doc.toString();
  view.destroy();
  return result;
}

test('P-004 inserts a default <limit/> just before </joint>', () => {
  const before = [
    '<robot>',
    '  <joint name="j" type="revolute">',
    '    <parent link="a"/>',
    '    <child link="b"/>',
    '    <axis xyz="0 0 1"/>',
    '  </joint>',
    '</robot>'
  ].join('\n');
  const after = apply('P-004', before, { line: 2 });
  assert.match(after, /<limit lower="-1\.57" upper="1\.57" effort="100" velocity="1\.0"\/>/);
});

test('P-003 replaces a negative mass with 1.0', () => {
  const before = [
    '<robot><link name="a">',
    '  <inertial>',
    '    <mass value="-2.5"/>',
    '    <inertia ixx="0.01" ixy="0" ixz="0" iyy="0.01" iyz="0" izz="0.01"/>',
    '  </inertial>',
    '</link></robot>'
  ].join('\n');
  const after = apply('P-003', before, { line: 1 });
  assert.match(after, /<mass value="1\.0"\/>/);
  assert.equal(after.includes('-2.5'), false);
});

test('P-006 rewrites zero effort + velocity', () => {
  const before = [
    '<robot><joint name="j" type="revolute">',
    '  <parent link="a"/><child link="b"/>',
    '  <limit lower="-1" upper="1" effort="0" velocity="0"/>',
    '</joint></robot>'
  ].join('\n');
  const after = apply('P-006', before, { line: 1 });
  assert.match(after, /effort="100"/);
  assert.match(after, /velocity="1\.0"/);
});

test('P-005 removes a stray <limit> from a continuous joint', () => {
  const before = [
    '<robot><joint name="j" type="continuous">',
    '  <parent link="a"/><child link="b"/>',
    '  <limit lower="-1" upper="1" effort="5" velocity="2"/>',
    '</joint></robot>'
  ].join('\n');
  const after = apply('P-005', before, { line: 1 });
  assert.equal(after.includes('<limit'), false, `limit not removed: ${after}`);
});

test('P-001 inserts an <inertial> block just before </link>', () => {
  const before = [
    '<robot>',
    '  <link name="a">',
    '    <visual><geometry><box size="0.1 0.1 0.1"/></geometry></visual>',
    '  </link>',
    '</robot>'
  ].join('\n');
  const after = apply('P-001', before, { line: 2 });
  assert.match(after, /<inertial>/);
  assert.match(after, /<mass value="1\.0"\/>/);
  assert.match(after, /<inertia\b[^>]*ixx="0\.01"/);
});

test('quick-fix is idempotent when diag.line is out of range', () => {
  const text = '<robot/>';
  const after = apply('P-004', text, { line: 99 });
  assert.equal(after, text, 'doc should be unchanged when line is invalid');
});

test('every registered fix has a non-empty label', () => {
  for (const [code, fix] of Object.entries(QUICK_FIXES)) {
    assert.ok(fix.label && fix.label.length > 0, `fix ${code} has empty label`);
  }
});

// Completion source tests — run the completion function against a series
// of synthetic CompletionContexts and assert the right options come back.
//
// We don't mount a real EditorView for these (the source function takes
// a CompletionContext-like object). This keeps the tests fast and lets
// us cover every code path explicitly.

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { EditorState, Text } from '@codemirror/state';
import { CompletionContext } from '@codemirror/autocomplete';
import { urdfCompletionSource, type CompletionContextProvider } from '../../src/editor/completion';

const provider: CompletionContextProvider = {
  linkNames: () => ['fr3_link0', 'fr3_link1', 'fr3_link2', 'fr3_hand'],
  jointNames: () => ['fr3_joint1', 'fr3_joint2', 'fr3_finger_joint1'],
  movableJointNames: () => ['fr3_joint1', 'fr3_joint2', 'fr3_finger_joint1'],
  packageNames: () => ['franka_description', 'my_robot']
};

function makeContext(text: string, pos: number, explicit = false): CompletionContext {
  const state = EditorState.create({ doc: Text.of(text.split('\n')) });
  return new CompletionContext(state, pos, explicit);
}

const source = urdfCompletionSource(provider, 'urdf');
const xacroSource = urdfCompletionSource(provider, 'xacro');

test('parent link="…" completes from declared link names', () => {
  const text = '<joint><parent link="';
  const result = source(makeContext(text, text.length));
  assert.ok(result);
  const labels = result!.options.map(o => o.label);
  assert.deepEqual(new Set(labels), new Set(provider.linkNames()));
});

test('child link="…" completes from declared link names', () => {
  const text = '<joint><child link="';
  const result = source(makeContext(text, text.length));
  assert.ok(result);
  assert.deepEqual(new Set(result!.options.map(o => o.label)), new Set(provider.linkNames()));
});

test('mimic joint="…" completes from movable joint names', () => {
  const text = '<mimic joint="';
  const result = source(makeContext(text, text.length));
  assert.ok(result);
  assert.deepEqual(new Set(result!.options.map(o => o.label)), new Set(provider.movableJointNames()));
});

test('type="…" completes with URDF joint types', () => {
  const text = '<joint name="x" type="';
  const result = source(makeContext(text, text.length));
  assert.ok(result);
  const labels = result!.options.map(o => o.label);
  for (const t of ['fixed', 'revolute', 'continuous', 'prismatic', 'floating', 'planar']) {
    assert.ok(labels.includes(t), `missing joint type ${t}`);
  }
});

test('filename="package://…" completes with package names', () => {
  const text = '<mesh filename="package://';
  const result = source(makeContext(text, text.length));
  assert.ok(result);
  assert.deepEqual(new Set(result!.options.map(o => o.label)), new Set(provider.packageNames()));
});

test('tag completion in URDF mode does NOT include xacro snippets', () => {
  const text = '<';
  const result = source(makeContext(text, text.length));
  assert.ok(result);
  const labels = result!.options.map(o => o.label);
  assert.ok(labels.includes('link'));
  assert.ok(labels.includes('joint'));
  assert.ok(!labels.some(l => l.startsWith('xacro:')), `xacro snippet leaked into URDF mode: ${labels.filter(l => l.startsWith('xacro:'))}`);
});

test('tag completion in xacro mode INCLUDES xacro snippets', () => {
  const text = '<';
  const result = xacroSource(makeContext(text, text.length));
  assert.ok(result);
  const labels = result!.options.map(o => o.label);
  assert.ok(labels.includes('xacro:macro'));
  assert.ok(labels.includes('xacro:property'));
  assert.ok(labels.includes('xacro:arg'));
  assert.ok(labels.includes('xacro:include'));
});

test('returns null when cursor is far from any trigger', () => {
  const text = 'just some <robot> text</robot>\nmore content';
  const result = source(makeContext(text, 5));
  // Cursor at position 5 ("just "). No completable context.
  assert.equal(result, null);
});

test('partial tag names still resolve to schema completions', () => {
  const text = '<lin';
  const result = source(makeContext(text, text.length));
  assert.ok(result);
  const labels = result!.options.map(o => o.label);
  assert.ok(labels.includes('link'));
});

test('link completion fires even with partial value', () => {
  const text = '<parent link="fr3_li';
  const result = source(makeContext(text, text.length));
  assert.ok(result);
  // CM6 will filter on its end; we just make sure the full list comes back.
  assert.equal(result!.options.length, provider.linkNames().length);
});

test('xacro property reference inside ${} does not trigger schema completion', () => {
  const text = '<link name="${prop}_x"';
  // Cursor inside the ${} block.
  const result = source(makeContext(text, 16));
  assert.equal(result, null, 'should not propose schema completions inside an expression');
});

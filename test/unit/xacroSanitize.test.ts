import { strict as assert } from 'node:assert';
import test from 'node:test';
import '../../src/core/io.node';
import { sanitizeXacroContent } from '../../src/core/xacro';

test('sanitizeXacroContent is a no-op when the skipped set is empty', () => {
  const input = '<robot><link name="${a + b}"/></robot>';
  assert.equal(sanitizeXacroContent(input, new Set()), input);
});

test('sanitizeXacroContent drops the whole ${} block when its body matched a skip target', () => {
  // Leaving `${}` behind re-fails the next parser pass ("Unknown character }").
  // The sanitiser's job is to make the expression evaluate to empty, so the
  // whole block must go.
  const input = '<robot name="r"><link name="${broken_call()}"/></robot>';
  const out = sanitizeXacroContent(input, new Set(['broken_call()']));
  assert.equal(out, '<robot name="r"><link name=""/></robot>');
});

test('sanitizeXacroContent does NOT touch matching text outside ${} brackets', () => {
  // The skipped expression text also appears as the literal string "ghost" in
  // an attribute value. The old, full-document `split().join('')` would erase
  // both — the scoped pass only touches the ${} occurrence (and now drops
  // the whole block when it matches).
  const skipped = 'ghost';
  const input = '<robot><link name="ghost_outside_expr"/><joint axis="${ghost}"/></robot>';
  const out = sanitizeXacroContent(input, new Set([skipped]));
  assert.match(out, /name="ghost_outside_expr"/);
  assert.match(out, /axis=""/);
});

test('sanitizeXacroContent leaves the original ${} block intact when no skipped expression appears inside', () => {
  const input = '<robot><link name="${prefix}_a"/></robot>';
  const out = sanitizeXacroContent(input, new Set(['some_other_thing']));
  assert.equal(out, input);
});

test('sanitizeXacroContent handles multiple skipped expressions in one block', () => {
  const input = '<robot><link name="${broken_a + broken_b}"/></robot>';
  const out = sanitizeXacroContent(input, new Set(['broken_a', 'broken_b']));
  assert.equal(out, '<robot><link name=""/></robot>');
});

test('sanitizeXacroContent does not corrupt content between ${} blocks', () => {
  const input = 'before-${dead_call(a)}-middle-${ok}-after';
  const out = sanitizeXacroContent(input, new Set(['dead_call(a)']));
  assert.equal(out, 'before--middle-${ok}-after');
});

test('sanitizeXacroContent tolerates empty-string in the skipped set', () => {
  const input = '<robot><link name="${a}"/></robot>';
  const out = sanitizeXacroContent(input, new Set(['']));
  assert.equal(out, input);
});

test('sanitizeXacroContent leaves unbalanced braces alone', () => {
  // A stray `${` without a closing `}` is not a complete expression block, so
  // the sanitiser MUST NOT touch the following text — handing back the raw
  // input is the safest behaviour.
  const input = 'before ${ unclosed text after';
  const out = sanitizeXacroContent(input, new Set(['unclosed']));
  assert.equal(out, input);
});

// =============================================================================
// Rospack-style $(...) substitutions: removed globally (legacy behaviour
// preserved so real ROS xacros with undefined `$(arg ...)` continue to
// degrade gracefully — see xacroSanitize regression note in xacro.ts).
// =============================================================================

test('sanitizeXacroContent removes a failed $(arg ...) rospack substitution globally', () => {
  const input = '<robot name="$(arg robot_name)"><link name="$(arg robot_name)_base"/></robot>';
  const out = sanitizeXacroContent(input, new Set(['$(arg robot_name)']));
  assert.equal(out, '<robot name=""><link name="_base"/></robot>');
});

test('sanitizeXacroContent handles mixed rospack and Python expression skips together', () => {
  const input = '<robot><link name="$(arg foo)_${broken}_tail"/></robot>';
  const out = sanitizeXacroContent(input, new Set(['$(arg foo)', 'broken']));
  assert.equal(out, '<robot><link name="__tail"/></robot>');
});

test('sanitizeXacroContent does not mistake a Python expression for rospack syntax', () => {
  // `$(`-prefixed text that isn't in the skipped set must survive untouched.
  // The `${broken}` block still gets sanitised (whole block dropped) — but
  // the lone `$(literal_token` text outside any expression block must remain.
  const input = 'plain $(literal_token and ${broken}';
  const out = sanitizeXacroContent(input, new Set(['broken']));
  assert.equal(out, 'plain $(literal_token and ');
});

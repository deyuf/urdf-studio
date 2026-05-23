// Live preview debounce tests.

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { createLivePreview } from '../../src/editor/livePreview';

// We use real setTimeout via `await sleep(ms)`. The debounce is tiny so
// tests remain fast.
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

test('debounces rapid notify() calls and applies only the latest text', async () => {
  let appliedWith: string | undefined;
  const preview = createLivePreview({
    debounceMs: 20,
    apply: text => { appliedWith = text; }
  });
  preview.notify('a');
  preview.notify('ab');
  preview.notify('abc');
  await sleep(40);
  assert.equal(appliedWith, 'abc');
  preview.dispose();
});

test('does not apply if dispose() runs before the debounce fires', async () => {
  let called = 0;
  const preview = createLivePreview({
    debounceMs: 30,
    apply: () => { called += 1; }
  });
  preview.notify('x');
  preview.dispose();
  await sleep(60);
  assert.equal(called, 0);
});

test('flush() applies immediately', () => {
  let appliedWith: string | undefined;
  const preview = createLivePreview({
    debounceMs: 500,
    apply: text => { appliedWith = text; }
  });
  preview.notify('flush-me');
  preview.flush();
  assert.equal(appliedWith, 'flush-me');
  preview.dispose();
});

test('flush() without a pending change is a no-op', () => {
  let called = 0;
  const preview = createLivePreview({
    debounceMs: 50,
    apply: () => { called += 1; }
  });
  preview.flush();
  assert.equal(called, 0);
  preview.dispose();
});

test('onPending fires true on notify, false on apply', async () => {
  const states: boolean[] = [];
  const preview = createLivePreview({
    debounceMs: 15,
    apply: () => undefined,
    onPending: pending => states.push(pending)
  });
  preview.notify('a');
  await sleep(30);
  assert.deepEqual(states, [true, false]);
  preview.dispose();
});

test('setDebounce updates the active interval', async () => {
  let appliedAt = 0;
  const preview = createLivePreview({
    debounceMs: 200,
    apply: () => { appliedAt = Date.now(); }
  });
  preview.setDebounce(15);
  const start = Date.now();
  preview.notify('a');
  await sleep(40);
  assert.ok(appliedAt - start < 80, `expected fast fire, got ${appliedAt - start}ms`);
  preview.dispose();
});

test('maxDebounceMs caps overly large debounce values', async () => {
  let appliedAt = 0;
  const preview = createLivePreview({
    debounceMs: 100000, // way too large
    maxDebounceMs: 25,
    apply: () => { appliedAt = Date.now(); }
  });
  const start = Date.now();
  preview.notify('a');
  await sleep(60);
  assert.ok(appliedAt > 0, 'apply should have fired');
  assert.ok(appliedAt - start < 80, `expected fast fire (capped at 25ms), got ${appliedAt - start}ms`);
  preview.dispose();
});

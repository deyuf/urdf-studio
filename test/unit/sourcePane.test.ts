import { strict as assert } from 'node:assert';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { mountSourcePane, VIRTUALIZE_THRESHOLD_LINES } from '../../src/renderer/logic/sourcePane';

// Single JSDOM window shared across tests. The new sourcePane is backed by
// CodeMirror 6 — JSDOM doesn't implement enough DOM (no real layout, no
// ResizeObserver). We patch in the bits CM6 actually reads so it can mount
// without throwing, then exercise the public surface.
//
// The visual / typing / autocompletion / live-preview pipeline is covered by
// the Playwright suite in test/renderer/editor.spec.ts which runs in real
// Chromium. This file confines itself to contract-level smoke tests.

const dom = new JSDOM('<!doctype html><html><body></body></html>');
const { window } = dom;
const w = window as unknown as Record<string, unknown>;
// navigator is non-writable in modern Node — leave the host one alone.
const g = globalThis as Record<string, unknown>;
g.window = window;
g.document = window.document;
g.HTMLElement = window.HTMLElement;
g.HTMLInputElement = window.HTMLInputElement;
g.HTMLAnchorElement = window.HTMLAnchorElement;
g.Node = window.Node;
g.Range = window.Range;
g.Element = window.Element;
g.Event = window.Event;
g.CustomEvent = window.CustomEvent;
g.KeyboardEvent = window.KeyboardEvent;
g.MouseEvent = window.MouseEvent;
g.MutationObserver = window.MutationObserver;
g.getComputedStyle = window.getComputedStyle.bind(window);
g.DOMRect = window.DOMRect;
// CM6 schedules measurement passes via requestAnimationFrame. In JSDOM
// without a real layout engine measurement returns garbage, and if the
// callback fires *after* a test completes node-test reports the run as
// failed with "asynchronous activity after the test ended". Stubbing rAF
// to a no-op keeps the view consistent (mount-time DOM is built
// synchronously) without queuing any post-test work.
(globalThis as { requestAnimationFrame?: (cb: FrameRequestCallback) => number }).requestAnimationFrame =
  () => 0;
(globalThis as { cancelAnimationFrame?: (id: number) => void }).cancelAnimationFrame =
  () => undefined;
g.requestAnimationFrame = () => 0;
g.cancelAnimationFrame = () => undefined;
// CM6 grabs rAF off the document's defaultView (this.win) — set it there too.
(window as unknown as { requestAnimationFrame?: typeof requestAnimationFrame }).requestAnimationFrame = () => 0;
(window as unknown as { cancelAnimationFrame?: typeof cancelAnimationFrame }).cancelAnimationFrame = () => undefined;

// CM6 reads ResizeObserver — provide a no-op so construction succeeds.
class StubResizeObserver {
  observe(): void { /* no-op */ }
  unobserve(): void { /* no-op */ }
  disconnect(): void { /* no-op */ }
}
if (!w.ResizeObserver) {
  w.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
}
(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver = w.ResizeObserver as typeof ResizeObserver;

function freshHost(): HTMLElement {
  const host = window.document.createElement('section');
  host.id = 'panel-source';
  window.document.body.appendChild(host);
  return host;
}

test('mountSourcePane returns the SourcePane contract', () => {
  const host = freshHost();
  const urdf = ['<robot>', '  <link/>', '</robot>'].join('\n');
  const pane = mountSourcePane(host, { fileName: 'r.urdf', format: 'urdf', urdf });
  try {
    assert.equal(typeof pane.setActiveLine, 'function');
    assert.equal(typeof pane.mountedLineCount, 'function');
    assert.equal(typeof pane.activeLine, 'function');
    assert.equal(typeof pane.refreshDiagnostics, 'function');
    assert.equal(typeof pane.getText, 'function');
    assert.equal(typeof pane.setEditable, 'function');
    assert.equal(pane.mountedLineCount(), 3);
    assert.equal(pane.getText(), urdf);
  } finally {
    pane.dispose();
    host.remove();
  }
});

test('mountSourcePane shows the file name and (expanded xacro) hint for xacro format', () => {
  const host = freshHost();
  const pane = mountSourcePane(host, { fileName: 'arm.xacro', format: 'xacro', urdf: '<robot/>' });
  try {
    const meta = host.querySelector('.source-meta');
    assert.ok(meta);
    assert.match(meta!.textContent ?? '', /arm\.xacro/);
    assert.match(meta!.textContent ?? '', /\(expanded xacro\)/);
  } finally {
    pane.dispose();
    host.remove();
  }
});

test('mountSourcePane renders edit + fullscreen toggle buttons in the toolbar', () => {
  const host = freshHost();
  const pane = mountSourcePane(host, { fileName: 'r.urdf', format: 'urdf', urdf: '<robot/>' });
  try {
    assert.ok(host.querySelector('.source-edit-toggle'));
    assert.ok(host.querySelector('.source-fullscreen-toggle'));
    assert.ok(host.querySelector('.editor-host'));
    assert.ok(host.querySelector('.editor-status'));
  } finally {
    pane.dispose();
    host.remove();
  }
});

test('mountSourcePane(editable: false) starts in read-only mode and toggles on click', () => {
  const host = freshHost();
  const pane = mountSourcePane(host, {
    fileName: 'r.urdf',
    format: 'urdf',
    urdf: '<robot/>',
    editable: false
  });
  try {
    const toggle = host.querySelector<HTMLButtonElement>('.source-edit-toggle');
    assert.ok(toggle);
    assert.equal(toggle!.classList.contains('active'), false);
    toggle!.click();
    assert.equal(toggle!.classList.contains('active'), true);
    assert.match(toggle!.textContent ?? '', /on/i);
  } finally {
    pane.dispose();
    host.remove();
  }
});

test('mountSourcePane fullscreen button dispatches the custom toggle event', () => {
  const host = freshHost();
  const pane = mountSourcePane(host, { fileName: 'r.urdf', format: 'urdf', urdf: '<robot/>' });
  let fired = 0;
  host.addEventListener('urdf-studio:request-fullscreen-toggle', () => { fired += 1; });
  try {
    const button = host.querySelector<HTMLButtonElement>('.source-fullscreen-toggle');
    button!.click();
    assert.equal(fired, 1);
  } finally {
    pane.dispose();
    host.remove();
  }
});

test('mountSourcePane swaps content cleanly when called twice on the same host', () => {
  const host = freshHost();
  const first = mountSourcePane(host, { fileName: 'a.urdf', format: 'urdf', urdf: '<a/>' });
  first.dispose();
  const second = mountSourcePane(host, { fileName: 'b.urdf', format: 'urdf', urdf: '<b/>\n<b/>' });
  try {
    const meta = host.querySelector('.source-meta');
    assert.ok(meta);
    assert.match(meta!.textContent ?? '', /b\.urdf/);
    assert.equal(second.mountedLineCount(), 2);
  } finally {
    second.dispose();
    host.remove();
  }
});

test('refreshDiagnostics updates the status bar counts', () => {
  const host = freshHost();
  const pane = mountSourcePane(host, { fileName: 'r.urdf', format: 'urdf', urdf: '<robot/>' });
  try {
    pane.refreshDiagnostics([
      { severity: 'error', message: 'e', code: 'X-001', line: 1 },
      { severity: 'warning', message: 'w', code: 'X-002', line: 1 },
      { severity: 'warning', message: 'w2', code: 'X-002', line: 1 }
    ]);
    const status = host.querySelector('.editor-status');
    assert.ok(status);
    assert.match(status!.textContent ?? '', /1 error/);
    assert.match(status!.textContent ?? '', /2 warnings/);
  } finally {
    pane.dispose();
    host.remove();
  }
});

test('VIRTUALIZE_THRESHOLD_LINES is still exported for backwards compatibility', () => {
  assert.equal(typeof VIRTUALIZE_THRESHOLD_LINES, 'number');
  assert.ok(VIRTUALIZE_THRESHOLD_LINES > 0);
});

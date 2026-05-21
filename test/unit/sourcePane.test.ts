import { strict as assert } from 'node:assert';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { mountSourcePane, VIRTUALIZE_THRESHOLD_LINES } from '../../src/renderer/logic/sourcePane';

// Single JSDOM window shared across tests. mountSourcePane writes into the
// host element passed in; nothing reaches the (test) document body unless we
// ask it to.
const dom = new JSDOM('<!doctype html><html><body></body></html>');
(globalThis as { window: Window }).window = dom.window as unknown as Window;
(globalThis as { document: Document }).document = dom.window.document;
(globalThis as { requestAnimationFrame?: (cb: FrameRequestCallback) => number }).requestAnimationFrame =
  (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 0) as unknown as number;

function freshHost(): HTMLElement {
  const host = dom.window.document.createElement('section');
  host.id = 'panel-source';
  dom.window.document.body.appendChild(host);
  return host;
}

// =============================================================================
// Eager mode: small files render every line
// =============================================================================

test('mountSourcePane (eager mode) renders one row per line', () => {
  const host = freshHost();
  const urdf = ['<robot>', '  <link/>', '</robot>'].join('\n');
  const pane = mountSourcePane(host, { fileName: 'r.urdf', format: 'urdf', urdf });
  try {
    assert.equal(pane.mountedLineCount(), 3);
    const rows = host.querySelectorAll('.source-line');
    assert.equal(rows.length, 3);
    assert.equal(rows[0].getAttribute('data-source-line'), '1');
    assert.equal(rows[2].getAttribute('data-source-line'), '3');
  } finally {
    pane.dispose();
    host.remove();
  }
});

test('mountSourcePane uses textContent so injected markup is shown literally, not parsed', () => {
  const host = freshHost();
  const urdf = '<robot name="<script>alert(1)</script>"/>';
  const pane = mountSourcePane(host, { fileName: 'r.urdf', format: 'urdf', urdf });
  try {
    const body = host.querySelector('.source-text');
    assert.ok(body);
    // No <script> tag exists in the DOM — it was rendered as text.
    assert.equal(host.querySelectorAll('script').length, 0);
    assert.equal(body!.textContent, urdf);
  } finally {
    pane.dispose();
    host.remove();
  }
});

test('mountSourcePane shows the file name and "(expanded xacro)" hint for xacro format', () => {
  const host = freshHost();
  const pane = mountSourcePane(host, { fileName: 'arm.xacro', format: 'xacro', urdf: '<robot/>' });
  try {
    const meta = host.querySelector('.source-meta');
    assert.ok(meta);
    assert.match(meta!.textContent ?? '', /arm\.xacro/);
    assert.match(meta!.textContent ?? '', /expanded xacro/);
  } finally {
    pane.dispose();
    host.remove();
  }
});

test('mountSourcePane uses a non-breaking placeholder for blank lines', () => {
  const host = freshHost();
  const urdf = '<robot>\n\n</robot>';
  const pane = mountSourcePane(host, { fileName: 'r.urdf', format: 'urdf', urdf });
  try {
    const rows = host.querySelectorAll('.source-line');
    const middleBody = rows[1].querySelector('.source-text');
    // Whitespace placeholder so the row keeps its layout height.
    assert.equal(middleBody!.textContent, ' ');
  } finally {
    pane.dispose();
    host.remove();
  }
});

// =============================================================================
// setActiveLine
// =============================================================================

test('setActiveLine adds the active class to the targeted row', () => {
  const host = freshHost();
  const urdf = ['<robot>', '  <link name="a"/>', '  <link name="b"/>', '</robot>'].join('\n');
  const pane = mountSourcePane(host, { fileName: 'r.urdf', format: 'urdf', urdf });
  try {
    pane.setActiveLine(2);
    assert.equal(pane.activeLine(), 2);
    const active = host.querySelectorAll('.source-line.active');
    assert.equal(active.length, 1);
    assert.equal(active[0].getAttribute('data-source-line'), '2');
  } finally {
    pane.dispose();
    host.remove();
  }
});

test('setActiveLine(undefined) clears any prior highlight', () => {
  const host = freshHost();
  const urdf = '<robot>\n  <link/>\n</robot>';
  const pane = mountSourcePane(host, { fileName: 'r.urdf', format: 'urdf', urdf });
  try {
    pane.setActiveLine(2);
    assert.equal(host.querySelectorAll('.source-line.active').length, 1);
    pane.setActiveLine(undefined);
    assert.equal(host.querySelectorAll('.source-line.active').length, 0);
    assert.equal(pane.activeLine(), undefined);
  } finally {
    pane.dispose();
    host.remove();
  }
});

test('setActiveLine moves the highlight when called repeatedly', () => {
  const host = freshHost();
  const urdf = '<robot>\n  <link/>\n  <link/>\n</robot>';
  const pane = mountSourcePane(host, { fileName: 'r.urdf', format: 'urdf', urdf });
  try {
    pane.setActiveLine(2);
    pane.setActiveLine(3);
    const active = host.querySelectorAll('.source-line.active');
    assert.equal(active.length, 1);
    assert.equal(active[0].getAttribute('data-source-line'), '3');
  } finally {
    pane.dispose();
    host.remove();
  }
});

// =============================================================================
// Virtualised mode: very large files do not pin every line into the DOM
// =============================================================================

test('mountSourcePane (virtualised mode) renders only a window of lines for huge files', () => {
  const host = freshHost();
  // Attach to body so layout is non-zero in JSDOM.
  const lineCount = VIRTUALIZE_THRESHOLD_LINES + 5000;
  const urdf = Array.from({ length: lineCount }, (_, i) => `<line index="${i}"/>`).join('\n');
  const pane = mountSourcePane(host, { fileName: 'huge.urdf', format: 'urdf', urdf });
  try {
    // The total mounted set must be strictly less than the total line count.
    const mounted = pane.mountedLineCount();
    assert.ok(mounted < lineCount, `mounted (${mounted}) should be < lineCount (${lineCount}) in virtualised mode`);
    // We must still render at least one line (otherwise the window is broken).
    assert.ok(mounted > 0, 'virtualised pane must mount at least one line');
  } finally {
    pane.dispose();
    host.remove();
  }
});

test('mountSourcePane (virtualised) creates a spacer sized to the full document', () => {
  const host = freshHost();
  const lineCount = VIRTUALIZE_THRESHOLD_LINES + 1000;
  const urdf = Array.from({ length: lineCount }, () => '<x/>').join('\n');
  const pane = mountSourcePane(host, { fileName: 'big.urdf', format: 'urdf', urdf });
  try {
    const spacer = host.querySelector<HTMLDivElement>('pre.source-view code > div[aria-hidden="true"]');
    assert.ok(spacer, 'virtualised mode must include an aria-hidden spacer for total height');
    assert.match(spacer!.style.height, /\d+px$/);
  } finally {
    pane.dispose();
    host.remove();
  }
});

test('mountSourcePane swaps content cleanly when called twice on the same host', () => {
  const host = freshHost();
  const firstPane = mountSourcePane(host, { fileName: 'first.urdf', format: 'urdf', urdf: '<a/>\n<b/>\n<c/>' });
  assert.equal(host.querySelectorAll('.source-line').length, 3);
  firstPane.dispose();

  const secondPane = mountSourcePane(host, { fileName: 'second.urdf', format: 'urdf', urdf: '<x/>\n<y/>' });
  try {
    assert.equal(host.querySelectorAll('.source-line').length, 2);
    assert.match(host.querySelector('.source-meta')?.textContent ?? '', /second\.urdf/);
  } finally {
    secondPane.dispose();
    host.remove();
  }
});

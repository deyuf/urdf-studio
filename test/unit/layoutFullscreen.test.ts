// Layout / fullscreen controller tests.

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { JSDOM } from 'jsdom';
import { createLayoutController } from '../../src/renderer/layout/fullscreen';

const dom = new JSDOM('<!doctype html><html><body><div class="workspace" id="workspace"></div></body></html>');
const g = globalThis as Record<string, unknown>;
g.window = dom.window;
g.document = dom.window.document;
g.KeyboardEvent = dom.window.KeyboardEvent;
g.CustomEvent = dom.window.CustomEvent;

function getWorkspace(): HTMLElement {
  const node = dom.window.document.getElementById('workspace');
  assert.ok(node);
  return node!;
}

test('createLayoutController starts in default mode', () => {
  const controller = createLayoutController(getWorkspace());
  try {
    assert.equal(controller.current(), 'default');
    assert.equal(getWorkspace().classList.contains('layout-source-fullscreen'), false);
    assert.equal(getWorkspace().classList.contains('layout-split'), false);
  } finally {
    controller.dispose();
  }
});

test('set("source-fullscreen") adds the right CSS class', () => {
  const controller = createLayoutController(getWorkspace());
  try {
    controller.set('source-fullscreen');
    assert.equal(controller.current(), 'source-fullscreen');
    assert.equal(getWorkspace().classList.contains('layout-source-fullscreen'), true);
  } finally {
    controller.dispose();
  }
});

test('set("split") adds layout-split class and removes any other layout', () => {
  const workspace = getWorkspace();
  workspace.classList.remove('layout-source-fullscreen', 'layout-split');
  const controller = createLayoutController(workspace);
  try {
    controller.set('source-fullscreen');
    controller.set('split');
    assert.equal(controller.current(), 'split');
    assert.equal(workspace.classList.contains('layout-split'), true);
    assert.equal(workspace.classList.contains('layout-source-fullscreen'), false);
  } finally {
    controller.dispose();
  }
});

test('onChange fires once per actual change', () => {
  const events: string[] = [];
  const controller = createLayoutController(getWorkspace(), mode => events.push(mode));
  try {
    controller.set('split');
    controller.set('split');           // no-op
    controller.set('source-fullscreen');
    controller.set('default');
    assert.deepEqual(events, ['split', 'source-fullscreen', 'default']);
  } finally {
    controller.dispose();
  }
});

test('cycle() walks default → split → source-fullscreen → default', () => {
  const workspace = getWorkspace();
  workspace.classList.remove('layout-source-fullscreen', 'layout-split');
  const controller = createLayoutController(workspace);
  try {
    assert.equal(controller.cycle(), 'split');
    assert.equal(controller.cycle(), 'source-fullscreen');
    assert.equal(controller.cycle(), 'default');
  } finally {
    controller.dispose();
  }
});

test('F11 key toggles source-fullscreen ↔ default', () => {
  const workspace = getWorkspace();
  workspace.classList.remove('layout-source-fullscreen', 'layout-split');
  const controller = createLayoutController(workspace);
  try {
    const event = new dom.window.KeyboardEvent('keydown', { key: 'F11' });
    dom.window.dispatchEvent(event);
    assert.equal(controller.current(), 'source-fullscreen');
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'F11' }));
    assert.equal(controller.current(), 'default');
  } finally {
    controller.dispose();
  }
});

test('Ctrl+Shift+F toggles source-fullscreen', () => {
  const workspace = getWorkspace();
  workspace.classList.remove('layout-source-fullscreen', 'layout-split');
  const controller = createLayoutController(workspace);
  try {
    dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'F', ctrlKey: true, shiftKey: true }));
    assert.equal(controller.current(), 'source-fullscreen');
  } finally {
    controller.dispose();
  }
});

test('custom event urdf-studio:request-fullscreen-toggle toggles layout', () => {
  const workspace = getWorkspace();
  workspace.classList.remove('layout-source-fullscreen', 'layout-split');
  const controller = createLayoutController(workspace);
  try {
    workspace.dispatchEvent(new dom.window.CustomEvent('urdf-studio:request-fullscreen-toggle', { bubbles: true }));
    assert.equal(controller.current(), 'source-fullscreen');
    workspace.dispatchEvent(new dom.window.CustomEvent('urdf-studio:request-fullscreen-toggle', { bubbles: true }));
    assert.equal(controller.current(), 'default');
  } finally {
    controller.dispose();
  }
});

test('dispose removes keyboard listener so further F11 events have no effect', () => {
  const workspace = getWorkspace();
  workspace.classList.remove('layout-source-fullscreen', 'layout-split');
  const controller = createLayoutController(workspace);
  controller.dispose();
  dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'F11' }));
  assert.equal(workspace.classList.contains('layout-source-fullscreen'), false);
});

test('F11 inside an <input> is ignored', () => {
  const workspace = getWorkspace();
  workspace.classList.remove('layout-source-fullscreen', 'layout-split');
  const input = dom.window.document.createElement('input');
  dom.window.document.body.appendChild(input);
  input.focus();
  const controller = createLayoutController(workspace);
  try {
    const event = new dom.window.KeyboardEvent('keydown', { key: 'F11', bubbles: true });
    input.dispatchEvent(event);
    assert.equal(controller.current(), 'default');
  } finally {
    controller.dispose();
    input.remove();
  }
});

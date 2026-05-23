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

test('set() applies the matching CSS class, removes the previous one, and fires onChange only on actual transitions', () => {
  const workspace = getWorkspace();
  workspace.classList.remove('layout-source-fullscreen', 'layout-split');
  const events: string[] = [];
  const controller = createLayoutController(workspace, mode => events.push(mode));
  try {
    controller.set('source-fullscreen');
    assert.equal(controller.current(), 'source-fullscreen');
    assert.equal(workspace.classList.contains('layout-source-fullscreen'), true);

    controller.set('split');
    assert.equal(workspace.classList.contains('layout-split'), true);
    assert.equal(workspace.classList.contains('layout-source-fullscreen'), false);

    controller.set('split');           // no-op (no transition)
    controller.set('default');
    assert.equal(workspace.classList.contains('layout-split'), false);

    assert.deepEqual(events, ['source-fullscreen', 'split', 'default']);
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

// Three independent inputs trigger the same toggle behaviour; consolidate
// into a parametric loop instead of three near-identical tests.
const TOGGLE_INPUTS: Array<{ name: string; fire: (workspace: HTMLElement) => void }> = [
  {
    name: 'F11 keydown',
    fire: () => dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'F11' }))
  },
  {
    name: 'Ctrl+Shift+F keydown',
    fire: () => dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'F', ctrlKey: true, shiftKey: true }))
  },
  {
    name: 'custom urdf-studio:request-fullscreen-toggle event',
    fire: workspace => workspace.dispatchEvent(new dom.window.CustomEvent('urdf-studio:request-fullscreen-toggle', { bubbles: true }))
  }
];

for (const { name, fire } of TOGGLE_INPUTS) {
  test(`${name} toggles source-fullscreen ↔ default`, () => {
    const workspace = getWorkspace();
    workspace.classList.remove('layout-source-fullscreen', 'layout-split');
    const controller = createLayoutController(workspace);
    try {
      fire(workspace);
      assert.equal(controller.current(), 'source-fullscreen');
      fire(workspace);
      assert.equal(controller.current(), 'default');
    } finally {
      controller.dispose();
    }
  });
}

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

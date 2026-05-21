import { strict as assert } from 'node:assert';
import test from 'node:test';

// Install a minimal localStorage shim BEFORE importing the storage module so
// it captures our backend instead of being a no-op.
class MemoryStorage {
  private map = new Map<string, string>();
  get length(): number { return this.map.size; }
  clear(): void { this.map.clear(); }
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
  removeItem(key: string): void { this.map.delete(key); }
  key(index: number): string | null { return Array.from(this.map.keys())[index] ?? null; }
}

const memStorage = new MemoryStorage();
(globalThis as { localStorage?: Storage }).localStorage = memStorage as unknown as Storage;

// Now import the storage module — it picks up the shim via the `backend()`
// resolver in storage.ts.
import {
  getSettings, saveSettings,
  getPreviewState, setPreviewState,
  getBookmarks, setBookmarks,
  STORAGE_VERSION,
  _internal
} from '../../src/web/storage';

test('STORAGE_VERSION is exported', () => {
  assert.equal(typeof STORAGE_VERSION, 'number');
  assert.ok(STORAGE_VERSION >= 1);
});

test('getSettings returns DEFAULT_SETTINGS when nothing is persisted', () => {
  memStorage.clear();
  const settings = getSettings();
  assert.equal(settings.defaultRenderMode, 'visual');
  assert.equal(settings.upAxis, '+Z');
  assert.deepEqual(settings.defaultXacroArgs, {});
  assert.deepEqual(settings.packageRoots, []);
  assert.deepEqual(settings.semanticFiles, []);
});

test('saveSettings persists and getSettings reads back', () => {
  memStorage.clear();
  saveSettings({ defaultRenderMode: 'collision', upAxis: '+X' });
  const settings = getSettings();
  assert.equal(settings.defaultRenderMode, 'collision');
  assert.equal(settings.upAxis, '+X');
});

test('saveSettings merges over the existing record', () => {
  memStorage.clear();
  saveSettings({ defaultRenderMode: 'collision' });
  saveSettings({ upAxis: '+Y' });
  const settings = getSettings();
  assert.equal(settings.defaultRenderMode, 'collision');
  assert.equal(settings.upAxis, '+Y');
});

test('getSettings sanitises invalid persisted values back to defaults', () => {
  memStorage.clear();
  memStorage.setItem(_internal.SETTINGS_KEY, JSON.stringify({
    defaultRenderMode: 'totally-not-a-mode',
    upAxis: 'sideways',
    defaultXacroArgs: 'not-an-object',
    packageRoots: 'not-an-array',
    semanticFiles: [1, 2, 3] // wrong element types
  }));
  const settings = getSettings();
  assert.equal(settings.defaultRenderMode, 'visual');
  assert.equal(settings.upAxis, '+Z');
  assert.deepEqual(settings.defaultXacroArgs, {});
  assert.deepEqual(settings.packageRoots, []);
  assert.deepEqual(settings.semanticFiles, []);
});

test('getSettings tolerates malformed JSON in storage', () => {
  memStorage.clear();
  memStorage.setItem(_internal.SETTINGS_KEY, '{not-valid-json');
  const settings = getSettings();
  assert.equal(settings.defaultRenderMode, 'visual');
});

// =============================================================================
// PreviewState
// =============================================================================

test('setPreviewState/getPreviewState round-trip a pose', () => {
  memStorage.clear();
  setPreviewState('robotA::path', { pose: { joint1: 1.5, joint2: -0.5 } });
  const state = getPreviewState('robotA::path');
  assert.deepEqual(state, { pose: { joint1: 1.5, joint2: -0.5 } });
});

test('PreviewState entries are namespaced by document key', () => {
  memStorage.clear();
  setPreviewState('a', { pose: { j: 1 } });
  setPreviewState('b', { pose: { j: 2 } });
  assert.deepEqual(getPreviewState('a'), { pose: { j: 1 } });
  assert.deepEqual(getPreviewState('b'), { pose: { j: 2 } });
});

// =============================================================================
// Bookmarks
// =============================================================================

test('setBookmarks/getBookmarks round-trip a list', () => {
  memStorage.clear();
  setBookmarks('robotA', [
    { name: 'home', pose: { j: 0 }, createdAt: '2024-01-01T00:00:00Z' },
    { name: 'away', pose: { j: 1 }, createdAt: '2024-01-02T00:00:00Z' }
  ]);
  const list = getBookmarks('robotA');
  assert.equal(list.length, 2);
  assert.equal(list[0].name, 'home');
});

test('getBookmarks defaults to empty array when key is missing', () => {
  memStorage.clear();
  assert.deepEqual(getBookmarks('nope'), []);
});

test('getBookmarks tolerates corrupt non-array entries', () => {
  memStorage.clear();
  memStorage.setItem(_internal.BOOKMARKS_KEY, JSON.stringify({ k: 'not-an-array' }));
  assert.deepEqual(getBookmarks('k'), []);
});

// =============================================================================
// Cross-call isolation
// =============================================================================

test('settings storage is separate from preview state and bookmarks', () => {
  memStorage.clear();
  saveSettings({ defaultRenderMode: 'both' });
  setPreviewState('docA', { pose: { j: 1 } });
  setBookmarks('docA', [{ name: 'b', pose: { j: 2 }, createdAt: 'now' }]);

  // Each lives under its own key.
  assert.notEqual(memStorage.getItem(_internal.SETTINGS_KEY), null);
  assert.notEqual(memStorage.getItem(_internal.POSE_KEY), null);
  assert.notEqual(memStorage.getItem(_internal.BOOKMARKS_KEY), null);
});

test('storage gracefully degrades when backend.setItem throws (Safari private mode)', () => {
  memStorage.clear();
  const originalSet = memStorage.setItem.bind(memStorage);
  memStorage.setItem = () => { throw new Error('QuotaExceeded'); };
  try {
    // Must not throw; in-memory state is still the source of truth for the
    // current session.
    saveSettings({ defaultRenderMode: 'both' });
    setPreviewState('any', { pose: { j: 1 } });
    setBookmarks('any', []);
  } finally {
    memStorage.setItem = originalSet;
  }
});

test('storage tolerates getItem throwing', () => {
  memStorage.clear();
  const originalGet = memStorage.getItem.bind(memStorage);
  memStorage.getItem = () => { throw new Error('access denied'); };
  try {
    // Falls back to defaults / empty
    const settings = getSettings();
    assert.equal(settings.defaultRenderMode, 'visual');
    assert.deepEqual(getBookmarks('x'), []);
    assert.equal(getPreviewState('x'), undefined);
  } finally {
    memStorage.getItem = originalGet;
  }
});

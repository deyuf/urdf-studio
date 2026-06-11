import { strict as assert } from 'node:assert';
import test from 'node:test';

// handleStore persists a structured-cloneable directory handle in IndexedDB.
// Node has no IndexedDB, so we install a small in-memory shim that implements
// exactly the request/transaction surface handleStore.ts uses. If a future
// change relies on IDB features the shim doesn't model, the tests below will
// fail loudly rather than flake.
//
// The shim is intentionally minimal and synchronous-resolving (callbacks fire
// on a microtask) — adequate for get/set/clear round-trips.

type Listener = (() => void) | null;

class FakeRequest<T> {
  result: T | undefined;
  onsuccess: Listener = null;
  onerror: Listener = null;
  onupgradeneeded: Listener = null;
  onblocked: Listener = null;
  fireSuccess(result?: T): void {
    this.result = result;
    queueMicrotask(() => this.onsuccess?.());
  }
}

class FakeObjectStore {
  constructor(private readonly map: Map<string, unknown>) {}
  put(value: unknown, key: string): FakeRequest<unknown> {
    const req = new FakeRequest<unknown>();
    this.map.set(key, value);
    req.fireSuccess(undefined);
    return req;
  }
  get(key: string): FakeRequest<unknown> {
    const req = new FakeRequest<unknown>();
    req.fireSuccess(this.map.get(key));
    return req;
  }
  delete(key: string): FakeRequest<undefined> {
    const req = new FakeRequest<undefined>();
    this.map.delete(key);
    req.fireSuccess(undefined);
    return req;
  }
}

class FakeTransaction {
  constructor(private readonly map: Map<string, unknown>) {}
  objectStore(): FakeObjectStore {
    return new FakeObjectStore(this.map);
  }
}

class FakeDb {
  objectStoreNames = {
    _names: new Set<string>(),
    contains(name: string): boolean { return this._names.has(name); }
  };
  constructor(private readonly map: Map<string, unknown>) {}
  createObjectStore(name: string): void {
    this.objectStoreNames._names.add(name);
  }
  transaction(): FakeTransaction {
    return new FakeTransaction(this.map);
  }
  close(): void { /* no-op */ }
}

function installFakeIndexedDb(): { store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  const db = new FakeDb(store);
  const fakeIndexedDb = {
    open(): FakeRequest<FakeDb> {
      const req = new FakeRequest<FakeDb>();
      req.result = db;
      // Run the upgrade once (store doesn't exist yet) then succeed.
      queueMicrotask(() => {
        if (!db.objectStoreNames.contains('handles')) {
          req.onupgradeneeded?.();
        }
        req.onsuccess?.();
      });
      return req;
    }
  };
  (globalThis as { indexedDB?: unknown }).indexedDB = fakeIndexedDb;
  return { store };
}

const hadIndexedDb = typeof (globalThis as { indexedDB?: unknown }).indexedDB !== 'undefined';
const fake = hadIndexedDb ? null : installFakeIndexedDb();

// handleStore.ts reads `indexedDB` lazily (inside its functions), not at
// module load, so a static import is safe as long as the shim above is
// installed before any of these functions are *called* (i.e. before the
// tests run).
import {
  setStoredDirectoryHandle,
  getStoredDirectoryHandle,
  clearStoredDirectoryHandle,
  canPersistHandles
} from '../../src/web/handleStore';

// A stand-in for FileSystemDirectoryHandle — structured-cloneable in the
// browser, just a plain object with the duck-typed fields here.
function fakeHandle(name: string): FileSystemDirectoryHandle {
  return {
    name,
    kind: 'directory',
    queryPermission: async () => 'granted'
  } as unknown as FileSystemDirectoryHandle;
}

// If we couldn't install a shim (real env already had one we don't control),
// skip rather than risk flakiness.
const runnable = fake !== null || canPersistHandles();

test('handleStore: canPersistHandles reports availability', { skip: !runnable }, () => {
  assert.equal(canPersistHandles(), true);
});

test('handleStore: set then get round-trips a handle', { skip: !runnable }, async () => {
  await setStoredDirectoryHandle(fakeHandle('my_pkg'));
  const got = await getStoredDirectoryHandle();
  assert.ok(got);
  assert.equal(got!.name, 'my_pkg');
});

test('handleStore: get returns null when nothing stored', { skip: !runnable }, async () => {
  await clearStoredDirectoryHandle();
  const got = await getStoredDirectoryHandle();
  assert.equal(got, null);
});

test('handleStore: clear removes a stored handle', { skip: !runnable }, async () => {
  await setStoredDirectoryHandle(fakeHandle('pkg2'));
  await clearStoredDirectoryHandle();
  const got = await getStoredDirectoryHandle();
  assert.equal(got, null);
});

test('handleStore: overwriting replaces the previous handle', { skip: !runnable }, async () => {
  await setStoredDirectoryHandle(fakeHandle('first'));
  await setStoredDirectoryHandle(fakeHandle('second'));
  const got = await getStoredDirectoryHandle();
  assert.equal(got!.name, 'second');
});

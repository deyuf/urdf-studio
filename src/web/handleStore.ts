// Persistence for the last-opened File System Access directory handle.
//
// FileSystemDirectoryHandle is structured-cloneable, so it can be stored
// directly in IndexedDB (it CANNOT be stored in localStorage — that only
// holds strings). On reload the handle is retrieved, but the browser revokes
// runtime permission across page loads, so it must be re-granted via a user
// gesture (queryPermission / requestPermission) before use.
//
// All operations degrade gracefully: if IndexedDB is unavailable (private
// mode, old browser, disabled), every function resolves to a safe no-op /
// null rather than throwing.

const DB_NAME = 'urdf-studio';
const DB_VERSION = 1;
const STORE_NAME = 'handles';
const HANDLE_KEY = 'lastDirectory';

function hasIndexedDb(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    return false;
  }
}

function openDb(): Promise<IDBDatabase | null> {
  if (!hasIndexedDb()) {
    return Promise.resolve(null);
  }
  return new Promise<IDBDatabase | null>(resolve => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch {
      resolve(null);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

function runTransaction<T>(
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => IDBRequest<T>
): Promise<T | null> {
  return openDb().then(db => {
    if (!db) {
      return null;
    }
    return new Promise<T | null>(resolve => {
      let request: IDBRequest<T>;
      try {
        const tx = db.transaction(STORE_NAME, mode);
        const store = tx.objectStore(STORE_NAME);
        request = body(store);
      } catch {
        db.close();
        resolve(null);
        return;
      }
      request.onsuccess = () => {
        const result = request.result;
        db.close();
        resolve(result ?? null);
      };
      request.onerror = () => {
        db.close();
        resolve(null);
      };
    });
  });
}

/** Persist the most-recently-opened directory handle. No-op without IndexedDB. */
export function setStoredDirectoryHandle(handle: FileSystemDirectoryHandle): Promise<void> {
  return runTransaction<IDBValidKey>('readwrite', store => store.put(handle, HANDLE_KEY)).then(() => undefined);
}

/** Retrieve the last stored directory handle, or null if none / unavailable. */
export function getStoredDirectoryHandle(): Promise<FileSystemDirectoryHandle | null> {
  return runTransaction<FileSystemDirectoryHandle>('readonly', store =>
    store.get(HANDLE_KEY) as IDBRequest<FileSystemDirectoryHandle>
  ).then(value => {
    // Guard against a value that no longer looks like a handle (e.g. a schema
    // change wrote something else). Only return objects that quack like one:
    // a directory handle exposes a string `kind` ('directory').
    if (value && typeof (value as { kind?: unknown }).kind === 'string') {
      return value;
    }
    return null;
  });
}

/** Remove the stored handle. Used when it goes stale or permission is denied. */
export function clearStoredDirectoryHandle(): Promise<void> {
  return runTransaction<undefined>('readwrite', store => store.delete(HANDLE_KEY)).then(() => undefined);
}

/** Whether persistence is possible in this environment. */
export function canPersistHandles(): boolean {
  return hasIndexedDb();
}

// Exposed for unit tests.
export const _internal = { DB_NAME, DB_VERSION, STORE_NAME, HANDLE_KEY };

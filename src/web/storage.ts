// LocalStorage-backed persistence for user pose/bookmarks/settings. Keyed by
// the absolute VFS path so different robots don't collide.
//
// Schema version is embedded in the key suffix (v1, v2, ...). When the schema
// grows past v1 we read the latest version that exists; legacy values can be
// silently migrated by readLatest() returning the most recent compatible store.

import type { PoseBookmark, PreviewState } from '../core/types';

export const STORAGE_VERSION = 1;
const POSE_KEY = `urdf-studio:pose:v${STORAGE_VERSION}`;
const BOOKMARKS_KEY = `urdf-studio:bookmarks:v${STORAGE_VERSION}`;
const SETTINGS_KEY = `urdf-studio:settings:v${STORAGE_VERSION}`;

export interface UserSettings {
  defaultRenderMode: 'visual' | 'collision' | 'both';
  upAxis: '+X' | '+Y' | '+Z';
  defaultXacroArgs: Record<string, unknown>;
  packageRoots: string[];
  semanticFiles: string[];
}

const DEFAULT_SETTINGS: UserSettings = {
  defaultRenderMode: 'visual',
  upAxis: '+Z',
  defaultXacroArgs: {},
  packageRoots: [],
  semanticFiles: []
};

// Storage backend: we resolve to localStorage on demand so the module works
// inside Node-side tests (where localStorage is provided as a shim).
function backend(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

function readJson<T>(key: string, fallback: T): T {
  const store = backend();
  if (!store) {
    return fallback;
  }
  try {
    const raw = store.getItem(key);
    if (!raw) {
      return fallback;
    }
    const parsed = JSON.parse(raw) as T;
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  const store = backend();
  if (!store) {
    return;
  }
  try {
    store.setItem(key, JSON.stringify(value));
  } catch {
    // localStorage may be disabled (private mode) or full. Persistence becomes
    // a no-op rather than throwing — the in-memory state of the session is
    // still authoritative.
  }
}

export function getSettings(): UserSettings {
  const stored = readJson<Partial<UserSettings>>(SETTINGS_KEY, {});
  return sanitizeSettings({ ...DEFAULT_SETTINGS, ...stored });
}

export function saveSettings(next: Partial<UserSettings>): UserSettings {
  const merged = sanitizeSettings({ ...getSettings(), ...next });
  writeJson(SETTINGS_KEY, merged);
  return merged;
}

function sanitizeSettings(input: UserSettings): UserSettings {
  return {
    defaultRenderMode: ['visual', 'collision', 'both'].includes(input.defaultRenderMode)
      ? input.defaultRenderMode
      : DEFAULT_SETTINGS.defaultRenderMode,
    upAxis: ['+X', '+Y', '+Z'].includes(input.upAxis) ? input.upAxis : DEFAULT_SETTINGS.upAxis,
    defaultXacroArgs: input.defaultXacroArgs && typeof input.defaultXacroArgs === 'object'
      ? input.defaultXacroArgs
      : {},
    packageRoots: Array.isArray(input.packageRoots) ? input.packageRoots.filter(s => typeof s === 'string') : [],
    semanticFiles: Array.isArray(input.semanticFiles) ? input.semanticFiles.filter(s => typeof s === 'string') : []
  };
}

export function getPreviewState(documentKey: string): PreviewState | undefined {
  const all = readJson<Record<string, PreviewState>>(POSE_KEY, {});
  return all[documentKey];
}

export function setPreviewState(documentKey: string, state: PreviewState): void {
  const all = readJson<Record<string, PreviewState>>(POSE_KEY, {});
  all[documentKey] = state;
  writeJson(POSE_KEY, all);
}

export function getBookmarks(documentKey: string): PoseBookmark[] {
  const all = readJson<Record<string, PoseBookmark[]>>(BOOKMARKS_KEY, {});
  const list = all[documentKey];
  return Array.isArray(list) ? list : [];
}

export function setBookmarks(documentKey: string, bookmarks: PoseBookmark[]): void {
  const all = readJson<Record<string, PoseBookmark[]>>(BOOKMARKS_KEY, {});
  all[documentKey] = bookmarks;
  writeJson(BOOKMARKS_KEY, all);
}

// Exposed for unit tests so we can verify the persisted shape without going
// through localStorage shimming.
export const _internal = { POSE_KEY, BOOKMARKS_KEY, SETTINGS_KEY };

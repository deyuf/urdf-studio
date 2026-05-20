// LocalStorage-backed persistence for user pose/bookmarks/settings. Keyed by
// the absolute VFS path so different robots don't collide.

import type { PoseBookmark, PreviewState } from '../core/types';

const POSE_KEY = 'urdf-studio:pose:v1';
const BOOKMARKS_KEY = 'urdf-studio:bookmarks:v1';
const SETTINGS_KEY = 'urdf-studio:settings:v1';

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

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
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
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // localStorage may be disabled (private mode). Persistence becomes a no-op.
  }
}

export function getSettings(): UserSettings {
  return { ...DEFAULT_SETTINGS, ...readJson<Partial<UserSettings>>(SETTINGS_KEY, {}) };
}

export function saveSettings(next: Partial<UserSettings>): UserSettings {
  const merged = { ...getSettings(), ...next };
  writeJson(SETTINGS_KEY, merged);
  return merged;
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
  return all[documentKey] ?? [];
}

export function setBookmarks(documentKey: string, bookmarks: PoseBookmark[]): void {
  const all = readJson<Record<string, PoseBookmark[]>>(BOOKMARKS_KEY, {});
  all[documentKey] = bookmarks;
  writeJson(BOOKMARKS_KEY, all);
}

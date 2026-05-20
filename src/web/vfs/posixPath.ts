// Minimal POSIX path utility for the browser build. Mirrors the subset of
// node:path/posix the core code uses. All paths in the web app are normalized
// to forward-slash form with a leading "/" for absolute paths.

function normalizeArray(parts: string[], allowAboveRoot: boolean): string[] {
  const out: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') {
      continue;
    }
    if (part === '..') {
      if (out.length > 0 && out[out.length - 1] !== '..') {
        out.pop();
      } else if (allowAboveRoot) {
        out.push('..');
      }
    } else {
      out.push(part);
    }
  }
  return out;
}

function normalize(p: string): string {
  const absolute = p.startsWith('/');
  const trailingSlash = p.endsWith('/') && p.length > 1;
  const parts = normalizeArray(p.split('/'), !absolute);
  let result = parts.join('/');
  if (!result && !absolute) {
    result = '.';
  }
  if (result && trailingSlash) {
    result += '/';
  }
  return (absolute ? '/' : '') + result;
}

export const posixPath = {
  sep: '/' as const,

  isAbsolute(p: string): boolean {
    return p.length > 0 && p.charCodeAt(0) === 47;
  },

  dirname(p: string): string {
    if (!p) {
      return '.';
    }
    let end = p.length;
    while (end > 1 && p.charCodeAt(end - 1) === 47) {
      end--;
    }
    let i = end - 1;
    while (i > 0 && p.charCodeAt(i) !== 47) {
      i--;
    }
    if (i === 0) {
      return p.charCodeAt(0) === 47 ? '/' : '.';
    }
    return p.slice(0, i);
  },

  basename(p: string, ext?: string): string {
    let end = p.length;
    while (end > 0 && p.charCodeAt(end - 1) === 47) {
      end--;
    }
    let start = 0;
    for (let i = end - 1; i >= 0; i--) {
      if (p.charCodeAt(i) === 47) {
        start = i + 1;
        break;
      }
    }
    let base = p.slice(start, end);
    if (ext && base.length > ext.length && base.endsWith(ext)) {
      base = base.slice(0, -ext.length);
    }
    return base;
  },

  extname(p: string): string {
    const base = posixPath.basename(p);
    const dot = base.lastIndexOf('.');
    if (dot <= 0) {
      return '';
    }
    return base.slice(dot);
  },

  join(...parts: string[]): string {
    const filtered = parts.filter(part => typeof part === 'string' && part.length > 0);
    if (filtered.length === 0) {
      return '.';
    }
    return normalize(filtered.join('/'));
  },

  resolve(...parts: string[]): string {
    let resolved = '';
    let absolute = false;
    for (let i = parts.length - 1; i >= 0 && !absolute; i--) {
      const segment = parts[i];
      if (typeof segment !== 'string' || segment.length === 0) {
        continue;
      }
      resolved = `${segment}/${resolved}`;
      absolute = segment.charCodeAt(0) === 47;
    }
    if (!absolute) {
      resolved = `/${resolved}`;
    }
    const normalized = normalize(resolved);
    if (normalized.length > 1 && normalized.endsWith('/')) {
      return normalized.slice(0, -1);
    }
    return normalized;
  }
};

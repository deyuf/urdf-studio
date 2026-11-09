import { DOMParser } from '@xmldom/xmldom';

export function parseXml(content: string, source = 'XML'): Document {
  const errors: string[] = [];
  // Browsers (and other lenient XML consumers) accept documents that the
  // strict @xmldom/xmldom handler would emit a *warning* for. Treat only
  // `error`/`fatalError` as fatal; warnings are collected but never abort the
  // parse so files real browsers accept are not rejected here.
  const doc = new DOMParser({
    errorHandler: {
      warning: () => { /* non-fatal: browsers accept these; ignore */ },
      error: message => errors.push(String(message)),
      fatalError: message => errors.push(String(message))
    }
  }).parseFromString(content, 'text/xml');

  const parserErrors = Array.from(doc.getElementsByTagName('parsererror')).map(node => node.textContent ?? '');
  errors.push(...parserErrors);

  if (errors.length > 0) {
    throw new Error(`${source} parse failed: ${errors.join('; ')}`);
  }

  // @xmldom/xmldom can return a Document with a null documentElement for
  // root-less input (e.g. `<?xml version="1.0"?><!-- comment -->`) without
  // reporting any error. Callers immediately dereference documentElement, so
  // surface this as a clear thrown Error and let their try/catch degrade to a
  // diagnostic instead of crashing with a TypeError.
  if (!doc.documentElement) {
    throw new Error(`${source} parse failed: document has no root element`);
  }

  return doc;
}

export function directChildren(element: Element, tagName?: string): Element[] {
  const result: Element[] = [];
  for (let i = 0; i < element.childNodes.length; i += 1) {
    const child = element.childNodes.item(i);
    if (child.nodeType === child.ELEMENT_NODE) {
      const childElement = child as Element;
      if (tagName === undefined || childElement.tagName === tagName) {
        result.push(childElement);
      }
    }
  }
  return result;
}

export function firstDirectChild(element: Element, tagName: string): Element | undefined {
  return directChildren(element, tagName)[0];
}

export function readNumber(value: string | null | undefined): number | undefined {
  if (value == null || value.trim() === '') {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export function readVector(value: string | null | undefined, fallback: [number, number, number]): [number, number, number] {
  if (value == null) {
    return fallback;
  }
  const parts = value.trim().split(/\s+/).map(Number);
  if (parts.length < 3 || parts.some(part => !Number.isFinite(part))) {
    return fallback;
  }
  return [parts[0], parts[1], parts[2]];
}

// Line lookups run once per link, joint and mesh against the same text, so
// keep the newline offsets of the most recent document and binary-search
// them. Re-splitting the prefix on every call made large files quadratic.
let indexedContent: string | undefined;
let newlineOffsets: number[] = [];

function newlinesOf(content: string): number[] {
  if (content !== indexedContent) {
    const offsets: number[] = [];
    for (let index = content.indexOf('\n'); index >= 0; index = content.indexOf('\n', index + 1)) {
      offsets.push(index);
    }
    indexedContent = content;
    newlineOffsets = offsets;
  }
  return newlineOffsets;
}

export function lineForNeedle(content: string, needle: string): number | undefined {
  const index = content.indexOf(needle);
  return index < 0 ? undefined : lineAtOffset(content, index);
}

/** 1-based line number of a character offset in `content`. */
export function lineAtOffset(content: string, index: number): number {
  // Line = number of newlines before `index`, plus one.
  const offsets = newlinesOf(content);
  let low = 0;
  let high = offsets.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if (offsets[mid] < index) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low + 1;
}


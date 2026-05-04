import { DOMParser } from '@xmldom/xmldom';

export function parseXml(content: string, source = 'XML'): Document {
  const errors: string[] = [];
  const doc = new DOMParser({
    errorHandler: {
      warning: message => errors.push(String(message)),
      error: message => errors.push(String(message)),
      fatalError: message => errors.push(String(message))
    }
  }).parseFromString(content, 'text/xml');

  const parserErrors = Array.from(doc.getElementsByTagName('parsererror')).map(node => node.textContent ?? '');
  errors.push(...parserErrors);

  if (errors.length > 0) {
    throw new Error(`${source} parse failed: ${errors.join('; ')}`);
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

export function lineForNeedle(content: string, needle: string): number | undefined {
  const index = content.indexOf(needle);
  if (index < 0) {
    return undefined;
  }
  return content.slice(0, index).split(/\r?\n/).length;
}


// Type-safe HTML templating for the renderer's panels.
//
// The renderer previously assembled DOM with `panel.innerHTML = \`...${val}...\``
// across ~15 sites, relying on a hand-written `escapeHtml()` at every
// interpolation point. Missing one escape is silently exploitable: URDF/SRDF
// source files come from outside the trust boundary (the user's workspace),
// and joint/link names, mesh paths, xacro arg values, etc. can in principle
// contain `<script>`-style payloads.
//
// This module provides:
//
//   html`<div class=${className}>${userText}</div>`
//     → returns a TrustedHtml whose payload has `userText` escaped and
//       `className` escaped. Nested html`...` results pass through verbatim
//       (already trusted), so composing fragments is straightforward.
//
//   setInnerHtml(element, html`...`)
//     → assigns the underlying string to `element.innerHTML`. Plain strings
//       are escaped before being written, so the call site cannot accidentally
//       smuggle raw markup in.
//
//   raw(value): TrustedHtml
//     → escape hatch for the rare case (e.g. a precomputed SVG snippet from
//       an internal helper). Use sparingly and only on values that did NOT
//       originate from outside the trust boundary.
//
// The wrapper class makes "is this value safe to inline" a type-level
// question; the linter (and humans) can spot a `.raw()` call instantly.

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;'
};

export class TrustedHtml {
  constructor(readonly value: string) {}
}

export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).replace(/[&<>"']/g, ch => ESCAPES[ch] ?? ch);
}

function interpolate(value: unknown): string {
  if (value instanceof TrustedHtml) {
    return value.value;
  }
  if (Array.isArray(value)) {
    return value.map(interpolate).join('');
  }
  if (value === false || value === null || value === undefined) {
    return '';
  }
  return escapeHtml(value);
}

export function html(strings: TemplateStringsArray, ...values: unknown[]): TrustedHtml {
  let result = strings[0];
  for (let i = 0; i < values.length; i++) {
    result += interpolate(values[i]) + strings[i + 1];
  }
  return new TrustedHtml(result);
}

// Mark a string as already-safe (precomputed by a trusted internal source).
// Prefer composition with `html\`\`` over calling this directly.
export function raw(value: string): TrustedHtml {
  return new TrustedHtml(value);
}

export function setInnerHtml(element: Element, content: TrustedHtml | string): void {
  if (content instanceof TrustedHtml) {
    element.innerHTML = content.value;
  } else {
    // Plain strings get escaped — assigning user-controlled text to
    // innerHTML directly is the exact mistake this module exists to prevent.
    element.innerHTML = escapeHtml(content);
  }
}

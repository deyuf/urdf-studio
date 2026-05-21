// Shared XML escaping helpers. Used by extension.ts and web/host.ts when
// emitting SRDF on disk, and by the analyzer/tests when building expected
// fragments. Keeping a single implementation guarantees identical encoding
// across both hosts.

const ATTR_REPLACEMENTS: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&apos;'
};

const TEXT_REPLACEMENTS: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;'
};

export function escapeXmlAttr(value: string): string {
  return value.replace(/[&<>"']/g, char => ATTR_REPLACEMENTS[char]);
}

export function escapeXmlText(value: string): string {
  return value.replace(/[&<>"]/g, char => TEXT_REPLACEMENTS[char]);
}

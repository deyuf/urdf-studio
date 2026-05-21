import type { XacroParser as UpstreamXacroParser } from 'xacro-parser';

// Locally-patched XacroParser exposes a `domParser` injection point that the
// upstream type declarations don't carry. Re-export the upstream class merged
// with the patch surface so callers stay type-safe.
export class XacroParser extends UpstreamXacroParser {
  domParser: { new(): DOMParser } | null;
}

import YAML from 'yaml';
import { directChildren, parseXml } from './xml';
import { getCoreIo } from './io';
import { escapeXmlAttr } from './escapeXml';
import type { DisableCollisionEntry, PackageMap, SemanticGroup, SemanticMetadata, SemanticState, StudioDiagnostic } from './types';

interface RawGroup {
  joints: string[];
  groups: string[];
}

export async function loadSemanticMetadata(files: string[], packages: PackageMap): Promise<SemanticMetadata> {
  const io = getCoreIo();
  const discoveredFiles = files.length > 0 ? files : await findDefaultSemanticFiles(packages);
  const groups = new Map<string, SemanticGroup>();
  const states: SemanticState[] = [];
  const disableCollisions: DisableCollisionEntry[] = [];
  const diagnostics: StudioDiagnostic[] = [];
  let sourceFile: string | undefined;

  for (const file of discoveredFiles) {
    const extension = io.extname(file).toLowerCase();
    try {
      const content = await io.readText(file);
      if (extension === '.srdf') {
        const parsed = parseSrdf(content, file);
        for (const group of parsed.groups) {
          groups.set(group.name, group);
        }
        states.push(...parsed.states);
        disableCollisions.push(...parsed.disableCollisions);
        diagnostics.push(...parsed.diagnostics);
        if (!sourceFile) {
          sourceFile = file;
        }
      } else if (extension === '.yaml' || extension === '.yml') {
        const parsed = parseInitialPositionsYaml(content, file);
        states.push(...parsed.states);
        diagnostics.push(...parsed.diagnostics);
      }
    } catch (error) {
      diagnostics.push({ severity: 'warning', message: `Could not read semantic file "${file}": ${String(error)}`, code: 'semantic.readFailed', file });
    }
  }

  return {
    groups: Array.from(groups.values()),
    states,
    disableCollisions,
    sourceFile,
    diagnostics
  };
}

export function parseSrdf(content: string, file = 'model.srdf'): SemanticMetadata {
  const diagnostics: StudioDiagnostic[] = [];
  let doc: Document;
  try {
    doc = parseXml(content, file);
  } catch (error) {
    return { groups: [], states: [], disableCollisions: [], diagnostics: [{ severity: 'error', message: String(error), code: 'srdf.parse', file }] };
  }

  const rawGroups = new Map<string, RawGroup>();
  for (const group of directChildren(doc.documentElement, 'group')) {
    const name = group.getAttribute('name')?.trim();
    if (!name) {
      diagnostics.push({ severity: 'warning', message: 'SRDF group without a name was ignored.', code: 'srdf.groupMissingName', file });
      continue;
    }
    rawGroups.set(name, {
      joints: directChildren(group, 'joint').map(joint => joint.getAttribute('name')?.trim()).filter(isString),
      groups: directChildren(group, 'group').map(subgroup => subgroup.getAttribute('name')?.trim()).filter(isString)
    });
  }

  // Memoize fully-expanded joint lists per group so a subgroup referenced by
  // many parents (a "diamond") is expanded once, not once per path. `seen`
  // tracks the current recursion path (for cycle detection) and is mutated in
  // place / restored rather than cloned per child, keeping expansion linear
  // instead of O(2^n) on diamond-shaped group graphs.
  const memo = new Map<string, string[]>();
  const expand = (name: string, seen = new Set<string>()): string[] => {
    if (seen.has(name)) {
      diagnostics.push({ severity: 'warning', message: `SRDF group cycle involving "${name}" was ignored.`, code: 'srdf.groupCycle', target: name, file });
      return [];
    }
    const cached = memo.get(name);
    if (cached) {
      return cached;
    }
    const raw = rawGroups.get(name);
    if (!raw) {
      diagnostics.push({ severity: 'warning', message: `SRDF subgroup "${name}" does not exist.`, code: 'srdf.groupMissing', target: name, file });
      return [];
    }
    seen.add(name);
    const result = Array.from(new Set([...raw.joints, ...raw.groups.flatMap(group => expand(group, seen))]));
    seen.delete(name);
    memo.set(name, result);
    return result;
  };

  const groups = Array.from(rawGroups.keys()).map(name => ({ name, joints: expand(name) }));
  const states: SemanticState[] = [];
  for (const state of directChildren(doc.documentElement, 'group_state')) {
    const name = state.getAttribute('name')?.trim();
    const group = state.getAttribute('group')?.trim();
    if (!name || !group) {
      diagnostics.push({ severity: 'warning', message: 'SRDF group_state without name or group was ignored.', code: 'srdf.stateInvalid', file });
      continue;
    }
    const joints: Record<string, number> = {};
    for (const joint of directChildren(state, 'joint')) {
      const jointName = joint.getAttribute('name')?.trim();
      const value = Number(joint.getAttribute('value'));
      if (jointName && Number.isFinite(value)) {
        joints[jointName] = value;
      }
    }
    states.push({ name, group, joints });
  }

  const disableCollisions: DisableCollisionEntry[] = [];
  for (const entry of directChildren(doc.documentElement, 'disable_collisions')) {
    const link1 = entry.getAttribute('link1')?.trim();
    const link2 = entry.getAttribute('link2')?.trim();
    if (!link1 || !link2) {
      continue;
    }
    disableCollisions.push({
      link1,
      link2,
      reason: entry.getAttribute('reason')?.trim() || undefined
    });
  }

  return { groups, states, disableCollisions, diagnostics };
}

function parseInitialPositionsYaml(content: string, file: string): Pick<SemanticMetadata, 'states' | 'diagnostics'> {
  try {
    const parsed = YAML.parse(content) as { initial_positions?: Record<string, unknown> } | null;
    const joints: Record<string, number> = {};
    for (const [name, value] of Object.entries(parsed?.initial_positions ?? {})) {
      const numeric = Number(value);
      if (Number.isFinite(numeric)) {
        joints[name] = numeric;
      }
    }
    return Object.keys(joints).length > 0
      ? { states: [{ name: 'initial_positions', group: 'all', joints }], diagnostics: [] }
      : { states: [], diagnostics: [] };
  } catch (error) {
    return { states: [], diagnostics: [{ severity: 'warning', message: `Could not parse YAML semantic file "${file}": ${String(error)}`, code: 'semantic.yamlParse', file }] };
  }
}

async function findDefaultSemanticFiles(packages: PackageMap): Promise<string[]> {
  const io = getCoreIo();
  const result: string[] = [];
  for (const entry of Object.values(packages)) {
    const configDir = io.join(entry.path, 'config');
    let entries: Awaited<ReturnType<typeof io.readdir>>;
    try {
      entries = await io.readdir(configDir);
    } catch {
      continue;
    }
    for (const item of entries) {
      if (item.isDirectory) {
        continue;
      }
      if (item.name.endsWith('.srdf') || item.name === 'initial_positions.yaml') {
        result.push(io.join(configDir, item.name));
      }
    }
  }
  return result;
}

function isString(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function buildDisableCollisionsXml(entries: DisableCollisionEntry[]): string {
  return entries
    .map(entry => `  <disable_collisions link1="${escapeXmlAttr(entry.link1)}" link2="${escapeXmlAttr(entry.link2)}"${entry.reason ? ` reason="${escapeXmlAttr(entry.reason)}"` : ''}/>`)
    .join('\n');
}

export function mergeDisableCollisionsIntoSrdf(content: string, entries: DisableCollisionEntry[]): { srdf: string; added: number } {
  if (entries.length === 0) {
    return { srdf: content, added: 0 };
  }

  const existing = new Set<string>();
  // Match both the self-closing form `<disable_collisions .../>` and the
  // element form `<disable_collisions ...></disable_collisions>` so existing
  // non-self-closing entries are deduped too.
  const existingRegex = /<disable_collisions\s+([^>]*?)\/?>/g;
  let match: RegExpExecArray | null;
  while ((match = existingRegex.exec(content)) !== null) {
    const attrs = match[1];
    const a = /link1="([^"]*)"/.exec(attrs)?.[1];
    const b = /link2="([^"]*)"/.exec(attrs)?.[1];
    if (a && b) {
      // On-disk values are XML-escaped; entry.link1/link2 are raw. Unescape
      // before comparing so the two sides are normalized to the same form.
      existing.add(canonicalPair(unescapeXmlAttr(a), unescapeXmlAttr(b)));
    }
  }

  const newEntries = entries.filter(entry => !existing.has(canonicalPair(entry.link1, entry.link2)));
  if (newEntries.length === 0) {
    return { srdf: content, added: 0 };
  }

  const xml = buildDisableCollisionsXml(newEntries);
  // Anchor to the LAST `</robot>` at the true end of the document. We can't use
  // a `/m` regex with `$` because that would match a `</robot>` sitting inside
  // a comment on its own line. Locate the final closing tag by index instead.
  const closeIndex = content.lastIndexOf('</robot>');
  // Only treat it as the document's closing tag if nothing but whitespace
  // follows it.
  if (closeIndex >= 0 && content.slice(closeIndex + '</robot>'.length).trim() === '') {
    // Use a replacer FUNCTION so user-controlled link names in `xml` (e.g. a
    // link named `a$&b`) are inserted literally rather than interpreted as
    // String.replace special patterns ($&, $', $`, $n).
    const before = content.slice(0, closeIndex);
    return {
      srdf: `${before}${xml}\n</robot>\n`,
      added: newEntries.length
    };
  }
  return {
    srdf: `${content.trimEnd()}\n${xml}\n`,
    added: newEntries.length
  };
}

function unescapeXmlAttr(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function canonicalPair(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

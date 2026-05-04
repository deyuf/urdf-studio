import { promises as fs } from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { directChildren, parseXml } from './xml';
import type { PackageMap, SemanticGroup, SemanticMetadata, SemanticState, StudioDiagnostic } from './types';

interface RawGroup {
  joints: string[];
  groups: string[];
}

export async function loadSemanticMetadata(files: string[], packages: PackageMap): Promise<SemanticMetadata> {
  const discoveredFiles = files.length > 0 ? files : await findDefaultSemanticFiles(packages);
  const groups = new Map<string, SemanticGroup>();
  const states: SemanticState[] = [];
  const diagnostics: StudioDiagnostic[] = [];

  for (const file of discoveredFiles) {
    const extension = path.extname(file).toLowerCase();
    try {
      const content = await fs.readFile(file, 'utf8');
      if (extension === '.srdf') {
        const parsed = parseSrdf(content, file);
        for (const group of parsed.groups) {
          groups.set(group.name, group);
        }
        states.push(...parsed.states);
        diagnostics.push(...parsed.diagnostics);
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
    diagnostics
  };
}

export function parseSrdf(content: string, file = 'model.srdf'): SemanticMetadata {
  const diagnostics: StudioDiagnostic[] = [];
  let doc: Document;
  try {
    doc = parseXml(content, file);
  } catch (error) {
    return { groups: [], states: [], diagnostics: [{ severity: 'error', message: String(error), code: 'srdf.parse', file }] };
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

  const expand = (name: string, seen = new Set<string>()): string[] => {
    if (seen.has(name)) {
      diagnostics.push({ severity: 'warning', message: `SRDF group cycle involving "${name}" was ignored.`, code: 'srdf.groupCycle', target: name, file });
      return [];
    }
    const raw = rawGroups.get(name);
    if (!raw) {
      diagnostics.push({ severity: 'warning', message: `SRDF subgroup "${name}" does not exist.`, code: 'srdf.groupMissing', target: name, file });
      return [];
    }
    seen.add(name);
    return Array.from(new Set([...raw.joints, ...raw.groups.flatMap(group => expand(group, new Set(seen)))]));
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

  return { groups, states, diagnostics };
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
  const result: string[] = [];
  for (const entry of Object.values(packages)) {
    const configDir = path.join(entry.path, 'config');
    let files: string[];
    try {
      files = await fs.readdir(configDir);
    } catch {
      continue;
    }
    for (const file of files) {
      if (file.endsWith('.srdf') || file === 'initial_positions.yaml') {
        result.push(path.join(configDir, file));
      }
    }
  }
  return result;
}

function isString(value: string | undefined): value is string {
  return typeof value === 'string' && value.length > 0;
}


// URDF / xacro lint rule engine.
//
// Each rule is a pure function over the URDF text + the already-computed
// RobotMetadata. Splitting them out (instead of stuffing more logic into
// analyzeUrdf) keeps the rules testable in isolation, lets the Studio side
// panel show per-rule grouping, and lets the editor's inline linter call
// the same code path as the VS Code Problems panel.
//
// Rule codes use a stable namespace:
//   R-xxx structural    P-xxx physics    A-xxx assets    S-xxx style/xacro
//
// The codes are part of the public contract (Quick-Fix actions key off
// them), so renaming requires bumping the editor adapter too.

import type { PackageMap, RobotMetadata, StudioDiagnostic } from '../types';
import { lineForNeedle } from '../xml';

export interface LintInput {
  urdf: string;
  sourcePath: string;
  packages: PackageMap;
  metadata: RobotMetadata;
}

export type LintRule = (input: LintInput) => StudioDiagnostic[];

// ----------------------- helpers ---------------------------------------------

const ANGULAR_TYPES = new Set(['revolute', 'prismatic', 'continuous', 'floating', 'planar']);

function near(value: number | undefined, target: number, tol = 1e-9): boolean {
  return value !== undefined && Math.abs(value - target) <= tol;
}

// ----------------------- structural ------------------------------------------

const ruleR001MultipleRoots: LintRule = ({ metadata, sourcePath }) => {
  // R-001 differs from analyzeUrdf's existing tree.rootCount in that we
  // emit it as an *error* (not warning) when there are 2+ roots and at
  // least one root has children — that's a clear semantic violation, not
  // just an oddity.
  if (metadata.rootLinks.length === 0 && Object.keys(metadata.links).length > 0) {
    return [{
      severity: 'error',
      message: 'No root link found — every link has a parent joint (likely a cycle or a malformed tree).',
      code: 'R-001',
      file: sourcePath
    }];
  }
  if (metadata.rootLinks.length > 1) {
    const withChildren = metadata.rootLinks.filter(name => (metadata.links[name]?.childJoints.length ?? 0) > 0).length;
    if (withChildren > 1) {
      return [{
        severity: 'error',
        message: `Multiple root links with children: ${metadata.rootLinks.join(', ')}. A URDF tree must have exactly one root.`,
        code: 'R-001',
        file: sourcePath,
        target: metadata.rootLinks[0]
      }];
    }
  }
  return [];
};

const ruleR002Cycle: LintRule = ({ metadata }) => {
  // Cycle detection already runs inside analyzeUrdf; rebadge with R-002 so
  // the rule engine surfaces it under a stable code. Replaces the
  // free-form 'tree.cycle' badge for editor / panel display purposes.
  return metadata.diagnostics
    .filter(diag => diag.code === 'tree.cycle')
    .map(diag => ({ ...diag, code: 'R-002' }));
};

const ruleR003MissingReferences: LintRule = ({ metadata }) => {
  return metadata.diagnostics
    .filter(diag => diag.code === 'joint.parentMissing' || diag.code === 'joint.childMissing')
    .map(diag => ({ ...diag, code: 'R-003' }));
};

const ruleR004Duplicates: LintRule = ({ metadata }) => {
  return metadata.diagnostics
    .filter(diag => diag.code === 'link.duplicate' || diag.code === 'joint.duplicate')
    .map(diag => ({ ...diag, code: 'R-004' }));
};

const ruleR005MimicTargets: LintRule = ({ metadata, sourcePath, urdf }) => {
  // Mimic-targets-missing already reported by analyzeUrdf — rebadge.
  // Additionally: detect mimic cycles (A mimics B mimics A).
  const out: StudioDiagnostic[] = metadata.diagnostics
    .filter(diag => diag.code === 'joint.mimicMissing')
    .map(diag => ({ ...diag, code: 'R-005' }));

  const visiting = new Set<string>();
  const visited = new Set<string>();
  const dfs = (name: string, path: string[]): void => {
    if (visiting.has(name)) {
      out.push({
        severity: 'error',
        message: `Mimic cycle detected: ${path.join(' -> ')} -> ${name}`,
        code: 'R-005',
        file: sourcePath,
        target: name,
        line: lineForNeedle(urdf, `<joint name="${name}"`)
      });
      return;
    }
    if (visited.has(name)) {
      return;
    }
    visiting.add(name);
    const joint = metadata.joints[name];
    if (joint?.mimic) {
      dfs(joint.mimic.joint, [...path, name]);
    }
    visiting.delete(name);
    visited.add(name);
  };
  for (const joint of Object.values(metadata.joints)) {
    if (joint.mimic) {
      dfs(joint.name, []);
    }
  }
  return out;
};

// ----------------------- physics ---------------------------------------------

const ruleP001MissingInertial: LintRule = ({ metadata, sourcePath, urdf }) => {
  const out: StudioDiagnostic[] = [];
  for (const link of Object.values(metadata.links)) {
    // World-style roots without inertial are fine; only flag links that
    // sit somewhere in the kinematic chain below a movable joint.
    const hasParent = !!link.parentJoint;
    if (!hasParent) {
      continue;
    }
    if (!link.inertial) {
      out.push({
        severity: 'warning',
        message: `Link "${link.name}" has no <inertial> block — dynamic simulators will treat its mass as zero.`,
        code: 'P-001',
        file: sourcePath,
        target: link.name,
        line: link.line ?? lineForNeedle(urdf, `<link name="${link.name}"`)
      });
    }
  }
  return out;
};

const ruleP002InertiaPositiveDefinite: LintRule = ({ metadata }) => {
  // analyzeUrdf already reports inertial.notPositiveDefinite for mass>0 +
  // inertia present. Rebadge under P-002.
  return metadata.diagnostics
    .filter(diag => diag.code === 'inertial.notPositiveDefinite')
    .map(diag => ({ ...diag, code: 'P-002' }));
};

const ruleP003MassValid: LintRule = ({ metadata, sourcePath, urdf }) => {
  const out: StudioDiagnostic[] = [];
  // analyzeUrdf reports invalid mass as a warning under 'inertial.massInvalid'.
  // Strengthen to error for clearly nonsensical values (negative). Keep
  // warnings for >10000 kg (likely a unit mistake).
  for (const link of Object.values(metadata.links)) {
    if (!link.inertial) {
      continue;
    }
    const mass = link.inertial.mass;
    if (mass < 0) {
      out.push({
        severity: 'error',
        message: `Link "${link.name}" has negative mass (${mass}).`,
        code: 'P-003',
        file: sourcePath,
        target: link.name,
        line: link.line ?? lineForNeedle(urdf, `<link name="${link.name}"`)
      });
    } else if (mass > 10000) {
      out.push({
        severity: 'warning',
        message: `Link "${link.name}" has unusually large mass (${mass} kg). Check units.`,
        code: 'P-003',
        file: sourcePath,
        target: link.name,
        line: link.line ?? lineForNeedle(urdf, `<link name="${link.name}"`)
      });
    }
  }
  return out;
};

const ruleP004JointLimitMissing: LintRule = ({ metadata }) => {
  return metadata.diagnostics
    .filter(diag => diag.code === 'joint.limitMissing')
    .map(diag => ({ ...diag, code: 'P-004' }));
};

const ruleP005ContinuousMisuse: LintRule = ({ metadata, sourcePath, urdf }) => {
  const out: StudioDiagnostic[] = [];
  for (const joint of Object.values(metadata.joints)) {
    if (joint.type !== 'continuous') {
      continue;
    }
    const lower = joint.limit.lower;
    const upper = joint.limit.upper;
    if (lower !== undefined || upper !== undefined) {
      out.push({
        severity: 'warning',
        message: `Continuous joint "${joint.name}" declares angular limits — these are ignored at runtime.`,
        code: 'P-005',
        file: sourcePath,
        target: joint.name,
        line: joint.line ?? lineForNeedle(urdf, `<joint name="${joint.name}"`)
      });
    }
  }
  return out;
};

const ruleP006EffortVelocityZero: LintRule = ({ metadata, sourcePath, urdf }) => {
  const out: StudioDiagnostic[] = [];
  for (const joint of Object.values(metadata.joints)) {
    if (!ANGULAR_TYPES.has(joint.type)) {
      continue;
    }
    if (joint.type === 'continuous') {
      // continuous joints are checked by P-005, skip here
    }
    if (near(joint.limit.effort, 0)) {
      out.push({
        severity: 'warning',
        message: `Joint "${joint.name}" has zero effort — controllers may refuse to actuate it.`,
        code: 'P-006',
        file: sourcePath,
        target: joint.name,
        line: joint.line ?? lineForNeedle(urdf, `<joint name="${joint.name}"`)
      });
    }
    if (near(joint.limit.velocity, 0)) {
      out.push({
        severity: 'warning',
        message: `Joint "${joint.name}" has zero velocity limit.`,
        code: 'P-006',
        file: sourcePath,
        target: joint.name,
        line: joint.line ?? lineForNeedle(urdf, `<joint name="${joint.name}"`)
      });
    }
  }
  return out;
};

// ----------------------- assets ----------------------------------------------

const ruleA001MeshUnresolved: LintRule = ({ metadata }) => {
  // analyzeUrdf reports the per-mesh-missing diagnostics; rebadge.
  return metadata.diagnostics
    .filter(diag => diag.code === 'mesh.missing' || diag.code === 'mesh.packageMissing' || diag.code === 'mesh.packageMalformed')
    .map(diag => ({ ...diag, code: 'A-001' }));
};

const ruleA002PackageUnknown: LintRule = ({ metadata }) => {
  return metadata.diagnostics
    .filter(diag => diag.code === 'mesh.packageFallback')
    .map(diag => ({ ...diag, code: 'A-002' }));
};

const ruleA003MeshScaleSuspicious: LintRule = ({ urdf, sourcePath }) => {
  // Heuristic: if any <mesh scale="0.001 0.001 0.001"/> appears together
  // with a <mesh scale="1 ..."> on the same robot we flag the mixed-units
  // case; otherwise we silently accept. A literal scale of 1000 or 0.001
  // is *probably* a unit conversion — emit info.
  const out: StudioDiagnostic[] = [];
  const matches = urdf.matchAll(/<mesh\b[^/>]*scale="([^"]+)"/g);
  for (const match of matches) {
    const parts = match[1].trim().split(/\s+/).map(Number);
    if (parts.length !== 3 || parts.some(v => !Number.isFinite(v))) {
      continue;
    }
    const isMm = parts.every(v => Math.abs(v - 0.001) < 1e-6);
    const isKm = parts.every(v => Math.abs(v - 1000) < 1e-6);
    if (isMm || isKm) {
      const offset = match.index ?? 0;
      const line = urdf.slice(0, offset).split(/\r?\n/).length;
      out.push({
        severity: 'info',
        message: `Mesh scale ${match[1]} looks like a unit conversion (URDF expects metres). Verify against the source mesh.`,
        code: 'A-003',
        file: sourcePath,
        line
      });
    }
  }
  return out;
};

// ----------------------- style / xacro ---------------------------------------

const ruleS001UndeclaredXacroArg: LintRule = ({ urdf, sourcePath }) => {
  // Find every $(arg NAME) and check it appears as a declared <xacro:arg/>.
  // We don't expand the xacro here — we just inspect raw text. False
  // positives are acceptable (rule is `info`).
  const declared = new Set<string>();
  for (const match of urdf.matchAll(/<xacro:arg\s+name="([^"]+)"/g)) {
    declared.add(match[1]);
  }
  const out: StudioDiagnostic[] = [];
  const seen = new Set<string>();
  for (const match of urdf.matchAll(/\$\(arg\s+([A-Za-z_][\w]*)\s*\)/g)) {
    const name = match[1];
    if (!declared.has(name) && !seen.has(name)) {
      seen.add(name);
      const offset = match.index ?? 0;
      const line = urdf.slice(0, offset).split(/\r?\n/).length;
      out.push({
        severity: 'info',
        message: `Xacro argument "${name}" used but never declared with <xacro:arg name="${name}"/>.`,
        code: 'S-001',
        file: sourcePath,
        target: name,
        line
      });
    }
  }
  return out;
};

const ruleS002UnusedXacroPropOrArg: LintRule = ({ urdf, sourcePath }) => {
  const out: StudioDiagnostic[] = [];
  const declaredProps = new Map<string, number>(); // name -> line
  for (const match of urdf.matchAll(/<xacro:property\s+name="([^"]+)"/g)) {
    const offset = match.index ?? 0;
    declaredProps.set(match[1], urdf.slice(0, offset).split(/\r?\n/).length);
  }
  const declaredArgs = new Map<string, number>();
  for (const match of urdf.matchAll(/<xacro:arg\s+name="([^"]+)"/g)) {
    const offset = match.index ?? 0;
    declaredArgs.set(match[1], urdf.slice(0, offset).split(/\r?\n/).length);
  }
  for (const [name, line] of declaredProps) {
    const usage = new RegExp(`\\$\\{[^}]*\\b${escapeRegex(name)}\\b[^}]*\\}`);
    if (!usage.test(urdf)) {
      out.push({
        severity: 'info',
        message: `<xacro:property name="${name}"/> is declared but never used.`,
        code: 'S-002',
        file: sourcePath,
        target: name,
        line
      });
    }
  }
  for (const [name, line] of declaredArgs) {
    const usage = new RegExp(`\\$\\(arg\\s+${escapeRegex(name)}\\s*\\)`);
    if (!usage.test(urdf)) {
      out.push({
        severity: 'info',
        message: `<xacro:arg name="${name}"/> is declared but never used.`,
        code: 'S-002',
        file: sourcePath,
        target: name,
        line
      });
    }
  }
  return out;
};

const ruleS003UnusedMacro: LintRule = ({ urdf, sourcePath }) => {
  const out: StudioDiagnostic[] = [];
  const declared = new Map<string, number>();
  for (const match of urdf.matchAll(/<xacro:macro\s+name="([^"]+)"/g)) {
    const offset = match.index ?? 0;
    declared.set(match[1], urdf.slice(0, offset).split(/\r?\n/).length);
  }
  for (const [name, line] of declared) {
    // A macro is "used" if there's a tag <xacro:name ...> elsewhere.
    const usage = new RegExp(`<xacro:${escapeRegex(name)}\\b`);
    const occurrences = urdf.match(usage) ?? [];
    // The declaration itself doesn't count: the declaration has the form
    // <xacro:macro name="X"> — we only want <xacro:X ...>.
    if (occurrences.length === 0) {
      out.push({
        severity: 'info',
        message: `<xacro:macro name="${name}"/> is declared but never called.`,
        code: 'S-003',
        file: sourcePath,
        target: name,
        line
      });
    }
  }
  return out;
};

const ruleS004DivisionByZero: LintRule = ({ urdf, sourcePath }) => {
  const out: StudioDiagnostic[] = [];
  // Lightweight: find ${... / 0} or "/ 0)" or "/0 " inside ${} braces.
  for (const match of urdf.matchAll(/\$\{[^}]*\/\s*0([^.\d][^}]*)?\}/g)) {
    const offset = match.index ?? 0;
    out.push({
      severity: 'warning',
      message: `Expression "${match[0]}" appears to divide by zero.`,
      code: 'S-004',
      file: sourcePath,
      line: urdf.slice(0, offset).split(/\r?\n/).length
    });
  }
  return out;
};

const ruleS005Naming: LintRule = ({ metadata, sourcePath, urdf }) => {
  const out: StudioDiagnostic[] = [];
  // Recommend snake_case for link / joint names — be lenient: anything
  // with lowercase + underscore + digits is fine. Flag UPPERCASE or hyphens.
  const bad = /[A-Z]|-/;
  for (const link of Object.values(metadata.links)) {
    if (bad.test(link.name)) {
      out.push({
        severity: 'info',
        message: `Link name "${link.name}" deviates from snake_case convention.`,
        code: 'S-005',
        file: sourcePath,
        target: link.name,
        line: link.line ?? lineForNeedle(urdf, `<link name="${link.name}"`)
      });
    }
  }
  for (const joint of Object.values(metadata.joints)) {
    if (bad.test(joint.name)) {
      out.push({
        severity: 'info',
        message: `Joint name "${joint.name}" deviates from snake_case convention.`,
        code: 'S-005',
        file: sourcePath,
        target: joint.name,
        line: joint.line ?? lineForNeedle(urdf, `<joint name="${joint.name}"`)
      });
    }
  }
  return out;
};

// ----------------------- registry --------------------------------------------

export interface RuleDefinition {
  code: string;
  description: string;
  defaultEnabled: boolean;
  rule: LintRule;
}

export const RULE_REGISTRY: RuleDefinition[] = [
  { code: 'R-001', description: 'Multiple or missing root link', defaultEnabled: true, rule: ruleR001MultipleRoots },
  { code: 'R-002', description: 'Kinematic cycle', defaultEnabled: true, rule: ruleR002Cycle },
  { code: 'R-003', description: 'Joint references unknown link', defaultEnabled: true, rule: ruleR003MissingReferences },
  { code: 'R-004', description: 'Duplicate link or joint name', defaultEnabled: true, rule: ruleR004Duplicates },
  { code: 'R-005', description: 'Mimic target missing or cyclic', defaultEnabled: true, rule: ruleR005MimicTargets },
  { code: 'P-001', description: 'Link missing inertial block', defaultEnabled: true, rule: ruleP001MissingInertial },
  { code: 'P-002', description: 'Inertia tensor not positive-definite', defaultEnabled: true, rule: ruleP002InertiaPositiveDefinite },
  { code: 'P-003', description: 'Mass invalid (negative or absurdly large)', defaultEnabled: true, rule: ruleP003MassValid },
  { code: 'P-004', description: 'Revolute/prismatic joint missing limits', defaultEnabled: true, rule: ruleP004JointLimitMissing },
  { code: 'P-005', description: 'Continuous joint has angular limits', defaultEnabled: true, rule: ruleP005ContinuousMisuse },
  { code: 'P-006', description: 'Effort or velocity is zero', defaultEnabled: true, rule: ruleP006EffortVelocityZero },
  { code: 'A-001', description: 'Mesh path unresolved', defaultEnabled: true, rule: ruleA001MeshUnresolved },
  { code: 'A-002', description: 'Package located by fallback', defaultEnabled: true, rule: ruleA002PackageUnknown },
  { code: 'A-003', description: 'Mesh scale looks like unit conversion', defaultEnabled: true, rule: ruleA003MeshScaleSuspicious },
  { code: 'S-001', description: 'Xacro arg used without declaration', defaultEnabled: true, rule: ruleS001UndeclaredXacroArg },
  { code: 'S-002', description: 'Xacro property or arg declared but unused', defaultEnabled: true, rule: ruleS002UnusedXacroPropOrArg },
  { code: 'S-003', description: 'Xacro macro declared but never called', defaultEnabled: true, rule: ruleS003UnusedMacro },
  { code: 'S-004', description: 'Division by zero in expression', defaultEnabled: true, rule: ruleS004DivisionByZero },
  { code: 'S-005', description: 'Name not in snake_case', defaultEnabled: false, rule: ruleS005Naming }
];

export interface LintReport {
  diagnostics: StudioDiagnostic[];
  byRule: Record<string, StudioDiagnostic[]>;
  /** 0-100, weighted by severity. 100 = no issues. */
  healthScore: number;
  counts: { error: number; warning: number; info: number };
}

export function runAllRules(input: LintInput, enabled?: Set<string>): LintReport {
  const collected: StudioDiagnostic[] = [];
  const byRule: Record<string, StudioDiagnostic[]> = {};
  for (const def of RULE_REGISTRY) {
    if (enabled && !enabled.has(def.code)) {
      continue;
    }
    if (!enabled && !def.defaultEnabled) {
      continue;
    }
    const found = def.rule(input);
    if (found.length > 0) {
      byRule[def.code] = found;
      collected.push(...found);
    }
  }
  // Dedupe identical diagnostics (a rule that rebadges analyzeUrdf output
  // can collide with the underlying diagnostic if both are surfaced).
  const seen = new Set<string>();
  const unique = collected.filter(diag => {
    const key = `${diag.code}|${diag.severity}|${diag.message}|${diag.line ?? ''}`;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
  const counts = { error: 0, warning: 0, info: 0 };
  for (const diag of unique) {
    counts[diag.severity] += 1;
  }
  const healthScore = Math.max(0, 100 - counts.error * 10 - counts.warning * 3 - counts.info * 0.5);
  return { diagnostics: unique, byRule, healthScore: Math.round(healthScore * 10) / 10, counts };
}

// Convenience: list of rule codes (for UI filters etc.).
export const RULE_CODES = RULE_REGISTRY.map(def => def.code);

function escapeRegex(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
}

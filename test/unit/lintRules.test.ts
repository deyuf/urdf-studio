// Lint rule engine tests.
//
// Strategy: build a known-good URDF and a deliberately-broken URDF (the
// franka_broken fixture) and assert that:
//   - the broken fixture trips every rule we expect
//   - the good fixture (franka_primitives) trips nothing critical
//   - rules are individually toggleable (enabled set)
//   - health score is monotonic in error/warning counts

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import '../../src/core/io.node';
import { analyzeUrdf } from '../../src/core/urdfAnalysis';
import { runAllRules, RULE_REGISTRY, RULE_CODES } from '../../src/core/lintRules';

// npm runs tests from the project root, so we anchor at process.cwd().
// The compiled .cjs lives in dist/test/ but the fixtures stay in test/.
const FIXTURE_ROOT = path.resolve(process.cwd(), 'test', 'fixtures');

function load(rel: string): string {
  return readFileSync(path.join(FIXTURE_ROOT, rel), 'utf-8');
}

function lint(urdf: string, sourcePath = 'test.urdf', enabled?: Set<string>) {
  const metadata = analyzeUrdf(urdf, sourcePath, {});
  return runAllRules({ urdf, sourcePath, packages: {}, metadata }, enabled);
}

// =====================================================================
// franka_primitives.urdf — the "healthy" fixture
// =====================================================================

test('franka_primitives has no errors and a high health score', () => {
  const urdf = load('franka_primitives.urdf');
  const report = lint(urdf);
  // Mesh / package rules can't fire because the fixture uses primitives.
  const errors = report.diagnostics.filter(d => d.severity === 'error');
  assert.equal(errors.length, 0, `unexpected errors: ${JSON.stringify(errors, null, 2)}`);
  assert.ok(report.healthScore >= 95, `health score too low: ${report.healthScore}`);
});

test('franka_primitives passes every default-enabled rule', () => {
  const urdf = load('franka_primitives.urdf');
  const report = lint(urdf);
  const triggeredCodes = Object.keys(report.byRule);
  // The fixture intentionally avoids triggering structural / physics rules.
  // Style rules (S-005 in particular) are off by default and won't fire.
  const forbiddenForFranka = ['R-001', 'R-002', 'R-003', 'R-004', 'R-005', 'P-001', 'P-002', 'P-003', 'P-004', 'P-005', 'P-006'];
  for (const code of forbiddenForFranka) {
    assert.ok(!triggeredCodes.includes(code), `${code} unexpectedly fired on franka_primitives: ${JSON.stringify(report.byRule[code])}`);
  }
});

// =====================================================================
// franka_broken.urdf — exercises every rule the fixture targets
// =====================================================================

const EXPECTED_BROKEN_CODES = [
  'R-002', // cycle (joint5 closes link1 -> link2 -> link3 -> link4 -> link1)
  'R-003', // missing parent (fr3_dangling -> missing_link)
  'R-004', // duplicate link name fr3_link0
  'R-005', // mimic to ghost_joint
  'P-001', // link without inertial (fr3_link1)
  'P-002', // negative ixx
  'P-003', // negative mass
  'P-004', // joint1 missing <limit>
  'P-005', // continuous joint with limit
  'P-006', // zero effort + velocity
  'A-001'  // mesh path nonexistent_pkg
];

for (const code of EXPECTED_BROKEN_CODES) {
  test(`franka_broken triggers rule ${code}`, () => {
    const urdf = load('franka_broken.urdf');
    const report = lint(urdf);
    assert.ok(
      report.byRule[code] && report.byRule[code].length > 0,
      `rule ${code} did not fire. Got: ${JSON.stringify(Object.keys(report.byRule))}`
    );
  });
}

test('franka_broken has at least one error in every fired rule that should be error-severity', () => {
  const urdf = load('franka_broken.urdf');
  const report = lint(urdf);
  // R-002/3/4/5, P-003 should each report at least one error.
  // R-005 (mimic target missing) and P-001 are warnings, not errors —
  // only check the rules we expect to be reported at error severity.
  for (const code of ['R-002', 'R-003', 'R-004', 'P-003', 'A-001']) {
    const hasError = (report.byRule[code] ?? []).some(d => d.severity === 'error');
    assert.ok(hasError, `${code} should have an error-severity diagnostic`);
  }
});

test('franka_broken health score is below 50 (many errors)', () => {
  const urdf = load('franka_broken.urdf');
  const report = lint(urdf);
  assert.ok(report.healthScore < 50, `health score should be poor for franka_broken, got ${report.healthScore}`);
});

// =====================================================================
// xacro-specific rules (S-001 .. S-004)
// =====================================================================

test('S-001: undeclared $(arg X) is flagged', () => {
  const urdf = `<?xml version="1.0"?>
<robot xmlns:xacro="http://www.ros.org/wiki/xacro" name="x">
  <link name="$(arg undeclared_arg)"/>
</robot>`;
  const report = lint(urdf, 'a.xacro');
  assert.ok(report.byRule['S-001'], 'S-001 should fire');
  assert.match(report.byRule['S-001'][0].message, /undeclared_arg/);
});

test('S-001: declared $(arg X) is NOT flagged', () => {
  const urdf = `<?xml version="1.0"?>
<robot xmlns:xacro="http://www.ros.org/wiki/xacro" name="x">
  <xacro:arg name="ok_arg" default="foo"/>
  <link name="$(arg ok_arg)"/>
</robot>`;
  const report = lint(urdf, 'a.xacro');
  assert.ok(!report.byRule['S-001'], 'S-001 should NOT fire when arg is declared');
});

test('S-002: unused <xacro:property> flagged', () => {
  const urdf = `<?xml version="1.0"?>
<robot xmlns:xacro="http://www.ros.org/wiki/xacro" name="x">
  <xacro:property name="unused_prop" value="3.14"/>
  <link name="a"/>
</robot>`;
  const report = lint(urdf, 'a.xacro');
  assert.ok(report.byRule['S-002'], 'S-002 should fire for unused property');
});

test('S-002: used <xacro:property> is NOT flagged', () => {
  const urdf = `<?xml version="1.0"?>
<robot xmlns:xacro="http://www.ros.org/wiki/xacro" name="x">
  <xacro:property name="used_prop" value="3.14"/>
  <link name="a"><visual><geometry><cylinder radius="\${used_prop}" length="0.1"/></geometry></visual></link>
</robot>`;
  const report = lint(urdf, 'a.xacro');
  assert.ok(!report.byRule['S-002'], 'S-002 should NOT fire when prop is referenced');
});

test('S-003: unused <xacro:macro> flagged', () => {
  const urdf = `<?xml version="1.0"?>
<robot xmlns:xacro="http://www.ros.org/wiki/xacro" name="x">
  <xacro:macro name="dead_macro" params="prefix">
    <link name="\${prefix}_x"/>
  </xacro:macro>
  <link name="root"/>
</robot>`;
  const report = lint(urdf, 'a.xacro');
  assert.ok(report.byRule['S-003'], 'S-003 should fire');
});

test('S-003: called macro is NOT flagged', () => {
  const urdf = `<?xml version="1.0"?>
<robot xmlns:xacro="http://www.ros.org/wiki/xacro" name="x">
  <xacro:macro name="live_macro" params="prefix">
    <link name="\${prefix}_x"/>
  </xacro:macro>
  <xacro:live_macro prefix="r"/>
</robot>`;
  const report = lint(urdf, 'a.xacro');
  assert.ok(!report.byRule['S-003']);
});

test('S-004: division by literal zero is flagged', () => {
  const urdf = `<?xml version="1.0"?>
<robot xmlns:xacro="http://www.ros.org/wiki/xacro" name="x">
  <xacro:property name="bad" value="\${5 / 0}"/>
</robot>`;
  const report = lint(urdf, 'a.xacro');
  assert.ok(report.byRule['S-004'], 'S-004 should fire');
});

// =====================================================================
// Style rule S-005 (off by default) — enable explicitly
// =====================================================================

test('S-005 (snake_case) fires only when explicitly enabled', () => {
  const urdf = `<?xml version="1.0"?>
<robot name="x">
  <link name="CamelCase"/>
  <link name="kebab-case"/>
</robot>`;
  const defaultReport = lint(urdf);
  assert.ok(!defaultReport.byRule['S-005'], 'S-005 should be off by default');

  const opted = lint(urdf, 'test.urdf', new Set(['S-005']));
  assert.ok(opted.byRule['S-005'], 'S-005 should fire when enabled');
});

// =====================================================================
// Asset rules: A-003 unit-conversion heuristic
// =====================================================================

test('A-003: mesh scale=0.001 emits info', () => {
  const urdf = `<?xml version="1.0"?>
<robot name="x">
  <link name="a">
    <visual><geometry><mesh filename="foo.dae" scale="0.001 0.001 0.001"/></geometry></visual>
  </link>
</robot>`;
  const report = lint(urdf);
  assert.ok(report.byRule['A-003']);
  assert.equal(report.byRule['A-003'][0].severity, 'info');
});

test('A-003: mesh scale=1 emits no info', () => {
  const urdf = `<?xml version="1.0"?>
<robot name="x">
  <link name="a">
    <visual><geometry><mesh filename="foo.dae" scale="1 1 1"/></geometry></visual>
  </link>
</robot>`;
  const report = lint(urdf);
  assert.ok(!report.byRule['A-003']);
});

// =====================================================================
// Engine plumbing
// =====================================================================

test('runAllRules returns dedupe-d diagnostics', () => {
  // Both analyzeUrdf and our rule wrappers emit the same set, but the
  // engine should dedupe by (code, message, line, severity).
  const urdf = load('franka_broken.urdf');
  const report = lint(urdf);
  const keys = new Set<string>();
  for (const d of report.diagnostics) {
    const k = `${d.code}|${d.severity}|${d.message}|${d.line ?? ''}`;
    assert.ok(!keys.has(k), `duplicate diagnostic ${k}`);
    keys.add(k);
  }
});

test('health score is bounded [0, 100]', () => {
  for (const fixture of ['franka_primitives.urdf', 'franka_broken.urdf']) {
    const report = lint(load(fixture));
    assert.ok(report.healthScore >= 0 && report.healthScore <= 100, `health out of bounds for ${fixture}: ${report.healthScore}`);
  }
});

test('RULE_REGISTRY codes are unique and stable', () => {
  const seen = new Set<string>();
  for (const def of RULE_REGISTRY) {
    assert.ok(!seen.has(def.code), `duplicate code ${def.code}`);
    seen.add(def.code);
    assert.match(def.code, /^[A-Z]-\d{3}$/, `bad code format: ${def.code}`);
  }
  assert.equal(RULE_CODES.length, RULE_REGISTRY.length);
});

test('explicit enabled set restricts rules', () => {
  const urdf = load('franka_broken.urdf');
  const onlyR002 = lint(urdf, 'test.urdf', new Set(['R-002']));
  assert.deepEqual(Object.keys(onlyR002.byRule), ['R-002']);
});

// =====================================================================
// Performance budget
// =====================================================================

test('runAllRules completes in <50ms on franka_broken.urdf', () => {
  const urdf = load('franka_broken.urdf');
  // Warm-up the JIT so the cold-start cost doesn't pollute the median.
  for (let i = 0; i < 5; i++) lint(urdf);
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) lint(urdf);
  const elapsed = (performance.now() - t0) / 20;
  assert.ok(elapsed < 50, `lint took ${elapsed.toFixed(2)}ms/run (budget 50ms)`);
});

test('runAllRules completes in <100ms on franka_primitives.urdf (200 lines)', () => {
  const urdf = load('franka_primitives.urdf');
  for (let i = 0; i < 5; i++) lint(urdf);
  const t0 = performance.now();
  for (let i = 0; i < 20; i++) lint(urdf);
  const elapsed = (performance.now() - t0) / 20;
  assert.ok(elapsed < 100, `lint took ${elapsed.toFixed(2)}ms/run (budget 100ms)`);
});

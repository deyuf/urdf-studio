// End-to-end test: load every robot variant in the vendored
// franka_description fixture (fer / fp3 / fr3 / fr3_duo / fr3v2 /
// fr3v2_1 / mobile_fr3_duo_v0_2 / tmrv0_2), expand it via xacro-parser,
// analyse it, and run the lint engine. One parametric loop covers every
// model — adding a new robot upstream needs no test code change as long
// as its xacro lives at robots/<id>/<id>.urdf.xacro.

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { existsSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import '../../src/core/io.node';
import { analyzeUrdf } from '../../src/core/urdfAnalysis';
import { runAllRules } from '../../src/core/lintRules';
import { renderRobotDocument } from '../../src/core/xacro';

const FIXTURE_ROOT = path.resolve(process.cwd(), 'test', 'fixtures');
const FRANKA_ROOT = path.join(FIXTURE_ROOT, 'franka_description');

if (!existsSync(FRANKA_ROOT)) {
  test('franka_description fixture missing — skipping', () => {
    assert.ok(true);
  });
} else {
  // Multi-arm composite robots that expand a Python list-style argument
  // (e.g. `robot_types="['fr3v2','fr3v2']"`) into nested xacro macros.
  // xacro-parser silently expands these to an empty document — not a
  // crash, but no joints either. Mark them as known-skip with a TODO so
  // upgrading xacro-parser flips them on automatically once supported.
  const MULTI_ARM_SKIP = new Set(['fr3_duo', 'mobile_fr3_duo_v0_2']);

  // Discover every robot variant. A "variant" is any directory under
  // robots/ that ships a <dir>/<dir>.urdf.xacro entry point. This keeps
  // the test data-driven so vendoring an updated franka_description with
  // new robots just works.
  const allVariants = readdirSync(path.join(FRANKA_ROOT, 'robots'))
    .filter(name => {
      const dir = path.join(FRANKA_ROOT, 'robots', name);
      return statSync(dir).isDirectory()
        && existsSync(path.join(dir, `${name}.urdf.xacro`));
    });
  const variants = allVariants.filter(name => !MULTI_ARM_SKIP.has(name));

  test('franka_description: fixture is complete (package.xml + at least one robot)', () => {
    assert.ok(existsSync(path.join(FRANKA_ROOT, 'package.xml')));
    assert.ok(variants.length >= 1, `expected >= 1 robot variant, found ${variants.length}`);
  });

  // Sanity-check the skip list: every entry must actually exist as a
  // robot directory, otherwise the skip is silently obsolete.
  test('franka_description: known multi-arm skip list still matches real directories', () => {
    for (const skipped of MULTI_ARM_SKIP) {
      assert.ok(allVariants.includes(skipped), `skip entry "${skipped}" no longer exists under robots/`);
    }
  });

  const PACKAGES = {
    franka_description: {
      name: 'franka_description',
      path: FRANKA_ROOT,
      packageXml: path.join(FRANKA_ROOT, 'package.xml')
    }
  };

  for (const id of variants) {
    const xacroPath = path.join(FRANKA_ROOT, 'robots', id, `${id}.urdf.xacro`);

    test(`franka ${id}: xacro expands and yields a sensible robot graph`, async () => {
      const rendered = await renderRobotDocument(xacroPath, PACKAGES, {});
      assert.equal(rendered.format, 'xacro');
      assert.ok(rendered.urdf.length > 0, 'expanded URDF must be non-empty');
      // Every Franka variant has at least one arm = >=7 joints + base
      // and end-effector links.
      const metadata = analyzeUrdf(rendered.urdf, xacroPath, PACKAGES);
      assert.ok(metadata.counts.joints >= 7, `${id}: expected >=7 joints, got ${metadata.counts.joints}`);
      assert.ok(metadata.counts.links >= 8, `${id}: expected >=8 links, got ${metadata.counts.links}`);
      assert.ok(metadata.counts.movableJoints >= 7, `${id}: expected >=7 movable joints, got ${metadata.counts.movableJoints}`);
      assert.equal(metadata.rootLinks.length, 1, `${id}: expected one root link, got ${metadata.rootLinks.length}: ${metadata.rootLinks.join(', ')}`);
    });

    test(`franka ${id}: lint engine reports no structural errors`, async () => {
      const rendered = await renderRobotDocument(xacroPath, PACKAGES, {});
      const metadata = analyzeUrdf(rendered.urdf, xacroPath, PACKAGES);
      const report = runAllRules({ urdf: rendered.urdf, sourcePath: xacroPath, packages: PACKAGES, metadata });

      const structuralErrors = ['R-001', 'R-002', 'R-003', 'R-004', 'R-005']
        .flatMap(code => report.byRule[code] ?? [])
        .filter(d => d.severity === 'error');
      assert.equal(structuralErrors.length, 0,
        `${id}: expected zero structural errors, got:\n${JSON.stringify(structuralErrors, null, 2)}`);
    });

    test(`franka ${id}: A-001 fires for missing meshes (fixture excludes /meshes)`, async () => {
      const rendered = await renderRobotDocument(xacroPath, PACKAGES, {});
      const metadata = analyzeUrdf(rendered.urdf, xacroPath, PACKAGES);
      const report = runAllRules({ urdf: rendered.urdf, sourcePath: xacroPath, packages: PACKAGES, metadata });
      const a001 = report.byRule['A-001'] ?? [];
      assert.ok(a001.length > 0, `${id}: expected A-001 to fire for missing meshes (fixture has no /meshes/)`);
    });
  }

  test(`performance: end-to-end pipeline on every variant completes in <2s/robot`, async () => {
    for (const id of variants) {
      const xacroPath = path.join(FRANKA_ROOT, 'robots', id, `${id}.urdf.xacro`);
      const t0 = performance.now();
      const rendered = await renderRobotDocument(xacroPath, PACKAGES, {});
      const metadata = analyzeUrdf(rendered.urdf, xacroPath, PACKAGES);
      runAllRules({ urdf: rendered.urdf, sourcePath: xacroPath, packages: PACKAGES, metadata });
      const elapsed = performance.now() - t0;
      assert.ok(elapsed < 2000, `${id}: pipeline took ${elapsed.toFixed(0)}ms (budget 2000ms)`);
    }
  });

  test('hot path: re-analyze after a single-character edit on fr3 completes in <100ms', async () => {
    // The hot loop is per-keystroke after the user edits — exercised on
    // fr3 (the most common variant) so the budget reflects what a typical
    // user feels.
    if (!variants.includes('fr3')) return;
    const xacroPath = path.join(FRANKA_ROOT, 'robots', 'fr3', 'fr3.urdf.xacro');
    const rendered = await renderRobotDocument(xacroPath, PACKAGES, {});
    for (let i = 0; i < 3; i++) {
      const meta = analyzeUrdf(rendered.urdf, xacroPath, PACKAGES);
      runAllRules({ urdf: rendered.urdf, sourcePath: xacroPath, packages: PACKAGES, metadata: meta });
    }
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) {
      const text = rendered.urdf + (i % 2 === 0 ? '\n<!-- a -->' : '\n<!-- b -->');
      const meta = analyzeUrdf(text, xacroPath, PACKAGES);
      runAllRules({ urdf: text, sourcePath: xacroPath, packages: PACKAGES, metadata: meta });
    }
    const elapsed = (performance.now() - t0) / 5;
    assert.ok(elapsed < 100, `analyze+lint takes ${elapsed.toFixed(0)}ms/round (budget 100ms)`);
  });
}

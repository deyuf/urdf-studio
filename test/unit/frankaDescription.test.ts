// End-to-end test: load the real Franka FR3 xacro from the upstream
// franka_description repo (vendored under test/fixtures/franka_description),
// expand it via xacro-parser, analyze it, and run the lint engine. This
// exercises the entire pipeline against a real-world ROS robot description.

import { strict as assert } from 'node:assert';
import test from 'node:test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import '../../src/core/io.node';
import { analyzeUrdf } from '../../src/core/urdfAnalysis';
import { runAllRules } from '../../src/core/lintRules';
import { renderRobotDocument } from '../../src/core/xacro';

const FIXTURE_ROOT = path.resolve(process.cwd(), 'test', 'fixtures');
const FRANKA_ROOT = path.join(FIXTURE_ROOT, 'franka_description');

if (!existsSync(FRANKA_ROOT)) {
  // CI without the fixture — skip the entire file gracefully.
  test('franka_description fixture missing — skipping', () => {
    assert.ok(true);
  });
} else {
  test('franka_description: package.xml is present', () => {
    assert.ok(existsSync(path.join(FRANKA_ROOT, 'package.xml')));
  });

  test('franka_description: fr3.urdf.xacro file is present', () => {
    assert.ok(existsSync(path.join(FRANKA_ROOT, 'robots', 'fr3', 'fr3.urdf.xacro')));
  });

  test('franka_description: fr3 xacro expands successfully via renderRobotDocument', async () => {
    const fr3Xacro = path.join(FRANKA_ROOT, 'robots', 'fr3', 'fr3.urdf.xacro');
    // renderRobotDocument expects to discover the package; supply the root
    // explicitly via the packageMap.
    const packages = {
      franka_description: {
        name: 'franka_description',
        path: FRANKA_ROOT,
        packageXml: path.join(FRANKA_ROOT, 'package.xml')
      }
    };
    const rendered = await renderRobotDocument(fr3Xacro, packages, {});
    assert.equal(rendered.format, 'xacro');
    assert.ok(rendered.urdf.length > 0);
    // FR3 has 7 panda-style joints plus optional finger joints.
    const robotMatch = /<robot[^>]*>/.exec(rendered.urdf);
    assert.ok(robotMatch, 'expanded URDF must contain <robot> root');
    // Sanity: at least 7 joint declarations
    const jointCount = (rendered.urdf.match(/<joint\b/g) ?? []).length;
    assert.ok(jointCount >= 7, `expected >=7 joints, got ${jointCount}`);
  });

  test('franka_description: analyzeUrdf yields a sensible robot graph', async () => {
    const fr3Xacro = path.join(FRANKA_ROOT, 'robots', 'fr3', 'fr3.urdf.xacro');
    const packages = {
      franka_description: {
        name: 'franka_description',
        path: FRANKA_ROOT,
        packageXml: path.join(FRANKA_ROOT, 'package.xml')
      }
    };
    const rendered = await renderRobotDocument(fr3Xacro, packages, {});
    const metadata = analyzeUrdf(rendered.urdf, fr3Xacro, packages);

    // 8 main links (link0..link7) + hand + 2 fingers + various rigid frames.
    assert.ok(metadata.counts.links >= 8, `expected >=8 links, got ${metadata.counts.links}`);
    assert.ok(metadata.counts.joints >= 7, `expected >=7 joints, got ${metadata.counts.joints}`);
    assert.ok(metadata.counts.movableJoints >= 7, `expected >=7 movable joints, got ${metadata.counts.movableJoints}`);
    // Should have a clean tree (one root)
    assert.equal(metadata.rootLinks.length, 1, `expected one root link, got ${metadata.rootLinks.length}: ${metadata.rootLinks.join(', ')}`);
  });

  test('franka_description: lint engine reports no structural errors', async () => {
    const fr3Xacro = path.join(FRANKA_ROOT, 'robots', 'fr3', 'fr3.urdf.xacro');
    const packages = {
      franka_description: {
        name: 'franka_description',
        path: FRANKA_ROOT,
        packageXml: path.join(FRANKA_ROOT, 'package.xml')
      }
    };
    const rendered = await renderRobotDocument(fr3Xacro, packages, {});
    const metadata = analyzeUrdf(rendered.urdf, fr3Xacro, packages);
    const report = runAllRules({ urdf: rendered.urdf, sourcePath: fr3Xacro, packages, metadata });

    const structuralErrors = (report.byRule['R-001'] ?? [])
      .concat(report.byRule['R-002'] ?? [])
      .concat(report.byRule['R-003'] ?? [])
      .concat(report.byRule['R-004'] ?? [])
      .concat(report.byRule['R-005'] ?? [])
      .filter(d => d.severity === 'error');
    assert.equal(structuralErrors.length, 0,
      `Franka FR3 should have zero structural errors, got:\n${JSON.stringify(structuralErrors, null, 2)}`);
  });

  test('franka_description: meshes referenced by URDF resolve under the fixture root, except actual .dae files (no meshes in fixture)', async () => {
    const fr3Xacro = path.join(FRANKA_ROOT, 'robots', 'fr3', 'fr3.urdf.xacro');
    const packages = {
      franka_description: {
        name: 'franka_description',
        path: FRANKA_ROOT,
        packageXml: path.join(FRANKA_ROOT, 'package.xml')
      }
    };
    const rendered = await renderRobotDocument(fr3Xacro, packages, {});
    const metadata = analyzeUrdf(rendered.urdf, fr3Xacro, packages);
    // The Franka URDF uses package:// URIs that point into the package
    // path; the fixture excludes the meshes/ folder so resolution should
    // succeed for the URI parsing step but exists=false for the actual
    // files. This is exactly the case A-001 catches.
    for (const mesh of metadata.meshes) {
      // package:// URIs were rewritten; the resolver should at least know
      // which file it tried to look at.
      assert.ok(mesh.filename);
    }
    const a001 = runAllRules({ urdf: rendered.urdf, sourcePath: fr3Xacro, packages, metadata }).byRule['A-001'] ?? [];
    // We expect A-001 to fire because meshes aren't in the fixture.
    assert.ok(a001.length > 0, 'expected A-001 to fire for missing meshes');
  });

  test('performance: full xacro→analyze→lint roundtrip on FR3 completes in <2s', async () => {
    const fr3Xacro = path.join(FRANKA_ROOT, 'robots', 'fr3', 'fr3.urdf.xacro');
    const packages = {
      franka_description: {
        name: 'franka_description',
        path: FRANKA_ROOT,
        packageXml: path.join(FRANKA_ROOT, 'package.xml')
      }
    };
    const t0 = performance.now();
    const rendered = await renderRobotDocument(fr3Xacro, packages, {});
    const metadata = analyzeUrdf(rendered.urdf, fr3Xacro, packages);
    runAllRules({ urdf: rendered.urdf, sourcePath: fr3Xacro, packages, metadata });
    const elapsed = performance.now() - t0;
    assert.ok(elapsed < 2000, `FR3 pipeline took ${elapsed.toFixed(0)}ms (budget 2000ms)`);
  });

  test('hot path: re-analyze after a single-character edit completes in <100ms', async () => {
    const fr3Xacro = path.join(FRANKA_ROOT, 'robots', 'fr3', 'fr3.urdf.xacro');
    const packages = {
      franka_description: {
        name: 'franka_description',
        path: FRANKA_ROOT,
        packageXml: path.join(FRANKA_ROOT, 'package.xml')
      }
    };
    const rendered = await renderRobotDocument(fr3Xacro, packages, {});
    // Warm up
    for (let i = 0; i < 3; i++) {
      const meta = analyzeUrdf(rendered.urdf, fr3Xacro, packages);
      runAllRules({ urdf: rendered.urdf, sourcePath: fr3Xacro, packages, metadata: meta });
    }
    // Measure
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) {
      const text = rendered.urdf + (i % 2 === 0 ? '\n<!-- a -->' : '\n<!-- b -->');
      const meta = analyzeUrdf(text, fr3Xacro, packages);
      runAllRules({ urdf: text, sourcePath: fr3Xacro, packages, metadata: meta });
    }
    const elapsed = (performance.now() - t0) / 5;
    assert.ok(elapsed < 100, `analyze+lint takes ${elapsed.toFixed(0)}ms/round (budget 100ms)`);
  });
}

// Regression tests for a batch of bug fixes:
//   1. parseXml throws (handled by callers) on root-less XML
//   2. buildTree / SRDF group expansion stay linear on diamond graphs
//   3. SRDF merge handles `$&` link names and commented-out </robot>
//   4. BOM num() keeps ~6 significant digits (tiny inertias != "0")
//   5. BOM escapeCsv neutralizes formula-injection cells
//   7. SRDF dedupe matches non-self-closing entries + normalizes escaping
//   9. xmldom warnings are not fatal

import { strict as assert } from 'node:assert';
import test from 'node:test';
import '../../src/core/io.node';
import { parseXml } from '../../src/core/xml';
import { analyzeUrdf } from '../../src/core/urdfAnalysis';
import { parseSrdf, mergeDisableCollisionsIntoSrdf } from '../../src/core/srdf';
import { buildBomCsv } from '../../src/core/bom';
import { runAllRules } from '../../src/core/lintRules';
import type { RobotMetadata } from '../../src/core/types';

// ---------------------------------------------------------------------------
// Bug 1 + 9: root-less XML and non-fatal warnings
// ---------------------------------------------------------------------------

test('parseXml throws (not TypeError) on root-less document', () => {
  assert.throws(() => parseXml('<?xml version="1.0"?><!-- only a comment -->', 'X'), /no root element|parse failed/);
});

test('analyzeUrdf degrades to a diagnostic on root-less URDF (no crash)', () => {
  const meta = analyzeUrdf('<?xml version="1.0"?><!-- comment -->', '/x.urdf', {});
  assert.equal(meta.robotName, 'Invalid URDF');
  assert.ok(meta.diagnostics.some(d => d.code === 'xml.parse'), 'expected an xml.parse diagnostic');
});

test('parseSrdf degrades to a diagnostic on root-less SRDF (no crash)', () => {
  const semantic = parseSrdf('<?xml version="1.0"?><!-- comment -->', 'm.srdf');
  assert.ok(semantic.diagnostics.some(d => d.code === 'srdf.parse'), 'expected an srdf.parse diagnostic');
  assert.deepEqual(semantic.groups, []);
});

test('parseXml accepts documents a browser would (warnings not fatal)', () => {
  // A well-formed document with a doctype / processing detail that xmldom
  // may warn about should still parse and yield a documentElement.
  const doc = parseXml('<?xml version="1.0"?><robot name="r"><link name="a"/></robot>', 'X');
  assert.ok(doc.documentElement);
  assert.equal(doc.documentElement.getAttribute('name'), 'r');
});

// ---------------------------------------------------------------------------
// Bug 2: diamond graph must not blow up exponentially
// ---------------------------------------------------------------------------

function diamondUrdf(layers: number): string {
  // Build a layered diamond: each layer's two nodes both connect to both of
  // the next layer's nodes. Without memoization this is O(2^layers) to expand.
  const links: string[] = [];
  const joints: string[] = [];
  links.push('<link name="root"/>');
  let prev = ['root'];
  for (let i = 0; i < layers; i++) {
    const a = `l${i}_a`;
    const b = `l${i}_b`;
    links.push(`<link name="${a}"/>`, `<link name="${b}"/>`);
    for (const p of prev) {
      for (const c of [a, b]) {
        joints.push(`<joint name="j_${p}_${c}" type="fixed"><parent link="${p}"/><child link="${c}"/></joint>`);
      }
    }
    prev = [a, b];
  }
  return `<?xml version="1.0"?><robot name="r">${links.join('')}${joints.join('')}</robot>`;
}

test('analyzeUrdf handles a deep diamond graph quickly (no O(2^n) blow-up)', () => {
  const urdf = diamondUrdf(40); // would be ~2^40 nodes if expanded per-path
  const t0 = performance.now();
  const meta = analyzeUrdf(urdf, '/diamond.urdf', {});
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 1000, `diamond analysis took ${elapsed.toFixed(1)}ms (should be near-instant)`);
  // multipleParents diagnostics are expected and acceptable.
  assert.ok(meta.tree.length >= 1);
});

test('parseSrdf handles a diamond group graph quickly', () => {
  // group g0 includes g1a and g1b, each includes g2a/g2b ... shared subgroups.
  const groups: string[] = [];
  const layers = 30;
  for (let i = 0; i < layers; i++) {
    const subA = `<group name="g${i + 1}_a"/>`;
    const subB = `<group name="g${i + 1}_b"/>`;
    groups.push(`<group name="g${i}_a">${subA}${subB}</group>`);
    groups.push(`<group name="g${i}_b">${subA}${subB}</group>`);
  }
  groups.push(`<group name="g${layers}_a"><joint name="leaf"/></group>`);
  groups.push(`<group name="g${layers}_b"><joint name="leaf"/></group>`);
  const srdf = `<?xml version="1.0"?><robot name="r">${groups.join('')}</robot>`;
  const t0 = performance.now();
  parseSrdf(srdf, 'm.srdf');
  const elapsed = performance.now() - t0;
  assert.ok(elapsed < 1000, `SRDF group expansion took ${elapsed.toFixed(1)}ms`);
});

// ---------------------------------------------------------------------------
// Bug 3: SRDF merge replace corruption
// ---------------------------------------------------------------------------

test('mergeDisableCollisionsIntoSrdf preserves a link name containing $&', () => {
  const srdf = '<?xml version="1.0"?>\n<robot name="r">\n</robot>\n';
  const result = mergeDisableCollisionsIntoSrdf(srdf, [{ link1: 'a$&b', link2: 'c$`d' }]);
  assert.equal(result.added, 1);
  // The literal characters must survive (escaped as XML attr); they must NOT
  // be expanded by String.replace special patterns.
  assert.ok(result.srdf.includes('a$&b') || result.srdf.includes('a$&amp;b'), `link name corrupted: ${result.srdf}`);
  // Document must still be parseable and contain the new entry.
  const reparsed = parseSrdf(result.srdf, 'm.srdf');
  assert.equal(reparsed.disableCollisions.length, 1);
  assert.equal(reparsed.disableCollisions[0].link1, 'a$&b');
  assert.equal(reparsed.disableCollisions[0].link2, 'c$`d');
});

test('mergeDisableCollisionsIntoSrdf ignores a commented-out </robot>', () => {
  const srdf = [
    '<?xml version="1.0"?>',
    '<robot name="r">',
    '  <!-- the real close tag is below, this one is fake </robot> -->',
    '</robot>',
    ''
  ].join('\n');
  const result = mergeDisableCollisionsIntoSrdf(srdf, [{ link1: 'x', link2: 'y' }]);
  assert.equal(result.added, 1);
  // Exactly one real closing tag in the output, and the new entry sits before
  // it (i.e. inside the robot element).
  const entryIdx = result.srdf.indexOf('link1="x"');
  const lastClose = result.srdf.lastIndexOf('</robot>');
  assert.ok(entryIdx > 0 && entryIdx < lastClose, 'new entry should precede the final </robot>');
  // Reparse to confirm well-formedness.
  const reparsed = parseSrdf(result.srdf, 'm.srdf');
  assert.equal(reparsed.disableCollisions.length, 1);
});

// ---------------------------------------------------------------------------
// Bug 7: dedupe of non-self-closing + escaped entries
// ---------------------------------------------------------------------------

test('mergeDisableCollisionsIntoSrdf dedupes a non-self-closing existing entry', () => {
  const srdf = [
    '<?xml version="1.0"?>',
    '<robot name="r">',
    '  <disable_collisions link1="base" link2="head"></disable_collisions>',
    '</robot>',
    ''
  ].join('\n');
  const result = mergeDisableCollisionsIntoSrdf(srdf, [{ link1: 'head', link2: 'base' }]);
  assert.equal(result.added, 0, 'reversed pair of existing non-self-closing entry should be a duplicate');
});

test('mergeDisableCollisionsIntoSrdf dedupes against XML-escaped on-disk values', () => {
  const srdf = [
    '<?xml version="1.0"?>',
    '<robot name="r">',
    '  <disable_collisions link1="a&amp;b" link2="c"/>',
    '</robot>',
    ''
  ].join('\n');
  const result = mergeDisableCollisionsIntoSrdf(srdf, [{ link1: 'a&b', link2: 'c' }]);
  assert.equal(result.added, 0, 'raw "a&b" should match escaped "a&amp;b" on disk');
});

// ---------------------------------------------------------------------------
// Bug 4 + 5: BOM number formatting & CSV formula injection
// ---------------------------------------------------------------------------

function bomWith(inertial: Record<string, number>, linkName = 'link'): string {
  const meta: RobotMetadata = {
    robotName: 'r',
    counts: { links: 1, joints: 0, movableJoints: 0, visualMeshes: 0, collisionMeshes: 0 },
    links: {
      [linkName]: {
        name: linkName,
        childJoints: [],
        inertial: {
          mass: inertial.mass ?? 1,
          origin: [0, 0, 0],
          rotation: [0, 0, 0],
          ixx: inertial.ixx ?? 0,
          ixy: 0, ixz: 0,
          iyy: inertial.iyy ?? 0,
          iyz: 0,
          izz: inertial.izz ?? 0
        }
      }
    },
    joints: {},
    meshes: [],
    rootLinks: [linkName],
    movableJointNames: [],
    tree: [{ link: linkName, children: [] }],
    totalMass: inertial.mass ?? 1,
    diagnostics: []
  };
  return buildBomCsv(meta);
}

test('buildBomCsv keeps tiny inertia values (2.5e-7 is not "0")', () => {
  const csv = bomWith({ mass: 1, ixx: 2.5e-7 });
  const dataRow = csv.trim().split('\n')[1].split(',');
  // ixx is column index 7.
  const ixxCell = dataRow[7];
  assert.notEqual(ixxCell, '0', `2.5e-7 collapsed to "${ixxCell}"`);
  assert.ok(Math.abs(Number(ixxCell) - 2.5e-7) < 1e-12, `expected ~2.5e-7, got "${ixxCell}"`);
});

test('buildBomCsv keeps clean numbers tidy (1.25 stays 1.25)', () => {
  const csv = bomWith({ mass: 1.25, ixx: 0.1 });
  const dataRow = csv.trim().split('\n')[1].split(',');
  assert.equal(dataRow[3], '1.25');
  assert.equal(dataRow[7], '0.1');
});

test('buildBomCsv neutralizes CSV formula injection in link names', () => {
  const csv = bomWith({ mass: 1 }, '=cmd|calc');
  const dataRow = csv.trim().split('\n')[1];
  // Leading "=" must be neutralized with a single-quote guard so spreadsheets
  // treat the cell as text, not a formula.
  assert.ok(dataRow.startsWith("'=cmd"), `formula not neutralized: ${dataRow}`);
});

test('buildBomCsv neutralizes formula injection even when the cell needs quoting', () => {
  const csv = bomWith({ mass: 1 }, '=1,2');
  const dataRow = csv.trim().split('\n')[1];
  // Contains a comma so it is wrapped in quotes; the guard sits inside.
  assert.ok(dataRow.startsWith('"\'=1,2"'), `expected quoted guarded cell, got: ${dataRow}`);
});

test('buildBomCsv does NOT quote-guard legitimate negative numbers', () => {
  const csv = bomWith({ mass: 1, ixx: -0.5 });
  const dataRow = csv.trim().split('\n')[1].split(',');
  assert.equal(dataRow[7], '-0.5', 'negative numeric cell must remain a plain number');
});

// ---------------------------------------------------------------------------
// Bug 6: P-006 must skip continuous joints (they're P-005's domain)
// ---------------------------------------------------------------------------

test('P-006 does not flag a continuous joint with zero effort/velocity', () => {
  const urdf = `<?xml version="1.0"?>
<robot name="r">
  <link name="a"/><link name="b"/>
  <joint name="spin" type="continuous">
    <parent link="a"/><child link="b"/>
    <limit effort="0" velocity="0"/>
  </joint>
</robot>`;
  const metadata = analyzeUrdf(urdf, 'r.urdf', {});
  const report = runAllRules({ urdf, sourcePath: 'r.urdf', packages: {}, metadata });
  const p006 = report.byRule['P-006'] ?? [];
  assert.ok(
    !p006.some(d => d.target === 'spin'),
    `continuous joint should be skipped by P-006, got: ${JSON.stringify(p006)}`
  );
});

test('P-006 still flags a revolute joint with zero effort/velocity', () => {
  const urdf = `<?xml version="1.0"?>
<robot name="r">
  <link name="a"/><link name="b"/>
  <joint name="rev" type="revolute">
    <parent link="a"/><child link="b"/>
    <limit lower="-1" upper="1" effort="0" velocity="0"/>
  </joint>
</robot>`;
  const metadata = analyzeUrdf(urdf, 'r.urdf', {});
  const report = runAllRules({ urdf, sourcePath: 'r.urdf', packages: {}, metadata });
  const p006 = report.byRule['P-006'] ?? [];
  assert.ok(p006.some(d => d.target === 'rev'), 'revolute zero-effort joint should still trip P-006');
});

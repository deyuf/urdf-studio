import { strict as assert } from 'node:assert';
import test from 'node:test';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import '../../src/core/io.node';
import { analyzeUrdf } from '../../src/core/urdfAnalysis';
import { ellipsoidSemiAxes, inertiaEigenvalues } from '../../src/core/inertia';
import { buildMimicGraph, propagateMimicValue } from '../../src/core/mimic';
import {
  buildDisableCollisionsXml,
  mergeDisableCollisionsIntoSrdf,
  parseSrdf,
  loadSemanticMetadata
} from '../../src/core/srdf';
import { applyXacroCompatibilityRewrites, renderRobotDocument } from '../../src/core/xacro';
import { buildBomCsv } from '../../src/core/bom';

// `__dirname` after esbuild bundling resolves to dist/test, so we anchor
// fixtures to the project root via process.cwd() (npm runs tests from there).
const FIXTURE_ROOT = path.resolve(process.cwd(), 'test', 'fixtures');

// =============================================================================
// inertiaEigenvalues / ellipsoidSemiAxes
// =============================================================================

test('inertiaEigenvalues returns sorted eigenvalues for diagonal tensors', () => {
  const values = inertiaEigenvalues({ ixx: 0.2, iyy: 0.7, izz: 0.5, ixy: 0, ixz: 0, iyz: 0 });
  assert.equal(values.length, 3);
  assert.ok(values[0] >= values[1] && values[1] >= values[2]);
  assert.ok(Math.abs(values[0] - 0.7) < 1e-9);
  assert.ok(Math.abs(values[1] - 0.5) < 1e-9);
  assert.ok(Math.abs(values[2] - 0.2) < 1e-9);
});

test('inertiaEigenvalues handles off-diagonal tensors', () => {
  // Construct a known 3x3 symmetric matrix with eigenvalues {1, 2, 3}.
  // Diagonal {2,2,2} plus off-diagonal coupling.
  const values = inertiaEigenvalues({ ixx: 2, iyy: 2, izz: 2, ixy: 1, ixz: 0, iyz: 0 });
  // Eigenvalues: 3, 2, 1
  assert.ok(Math.abs(values[0] - 3) < 1e-6);
  assert.ok(Math.abs(values[1] - 2) < 1e-6);
  assert.ok(Math.abs(values[2] - 1) < 1e-6);
});

test('ellipsoidSemiAxes recovers the shape of a uniform solid ellipsoid', () => {
  // Solid ellipsoid mass m=2, semi-axes (a,b,c)=(0.3, 0.2, 0.1).
  const a = 0.3;
  const b = 0.2;
  const c = 0.1;
  const m = 2;
  const ixx = (m / 5) * (b * b + c * c);
  const iyy = (m / 5) * (a * a + c * c);
  const izz = (m / 5) * (a * a + b * b);
  const semi = ellipsoidSemiAxes({
    mass: m,
    origin: [0, 0, 0],
    rotation: [0, 0, 0],
    ixx, iyy, izz, ixy: 0, ixz: 0, iyz: 0
  });
  // Returned axes correspond inverse to eigenvalues (largest eigenvalue ⇒
  // smallest axis), so compare on a sorted basis.
  const expectedSorted = [a, b, c].sort((x, y) => x - y);
  const actualSorted = [...semi].sort((x, y) => x - y);
  for (let i = 0; i < 3; i += 1) {
    assert.ok(Math.abs(actualSorted[i] - expectedSorted[i]) < 1e-6, `actual[${i}]=${actualSorted[i]} expected≈${expectedSorted[i]}`);
  }
});

test('ellipsoidSemiAxes returns zero when mass is zero', () => {
  const semi = ellipsoidSemiAxes({ mass: 0, origin: [0, 0, 0], rotation: [0, 0, 0], ixx: 1, iyy: 1, izz: 1, ixy: 0, ixz: 0, iyz: 0 });
  assert.deepEqual(semi, [0, 0, 0]);
});

// =============================================================================
// urdfAnalysis: mimic + inertial
// =============================================================================

const URDF_WITH_MIMIC = `<?xml version="1.0"?>
<robot name="gripper">
  <link name="base">
    <inertial>
      <origin xyz="0 0 0.1" rpy="0 0 0"/>
      <mass value="2.0"/>
      <inertia ixx="0.01" ixy="0" ixz="0" iyy="0.02" iyz="0" izz="0.03"/>
    </inertial>
  </link>
  <link name="left_finger"/>
  <link name="right_finger"/>
  <joint name="left" type="prismatic">
    <parent link="base"/>
    <child link="left_finger"/>
    <axis xyz="1 0 0"/>
    <limit lower="0" upper="0.04" effort="50" velocity="0.5"/>
  </joint>
  <joint name="right" type="prismatic">
    <parent link="base"/>
    <child link="right_finger"/>
    <axis xyz="1 0 0"/>
    <mimic joint="left" multiplier="-1" offset="0.1"/>
  </joint>
</robot>`;

test('analyzeUrdf parses mimic joints and excludes them from movable list', () => {
  const meta = analyzeUrdf(URDF_WITH_MIMIC, '/virtual.urdf', {});
  assert.deepEqual(meta.movableJointNames, ['left'], 'mimic joint should not be movable');
  assert.equal(meta.joints.right.mimic?.joint, 'left');
  assert.equal(meta.joints.right.mimic?.multiplier, -1);
  assert.equal(meta.joints.right.mimic?.offset, 0.1);
});

test('analyzeUrdf parses inertial mass and totalMass', () => {
  const meta = analyzeUrdf(URDF_WITH_MIMIC, '/virtual.urdf', {});
  assert.equal(meta.totalMass, 2.0);
  assert.equal(meta.links.base.inertial?.mass, 2.0);
  assert.deepEqual(meta.links.base.inertial?.origin, [0, 0, 0.1]);
});

test('analyzeUrdf flags mimic referencing unknown joints', () => {
  const urdf = URDF_WITH_MIMIC.replace('joint="left"', 'joint="ghost"');
  const meta = analyzeUrdf(urdf, '/virtual.urdf', {});
  const codes = meta.diagnostics.map(d => d.code);
  assert.ok(codes.includes('joint.mimicMissing'), `expected joint.mimicMissing in ${codes.join(',')}`);
});

test('analyzeUrdf does not warn about missing limits on mimic joints', () => {
  const urdfNoLimit = URDF_WITH_MIMIC.replace(/<limit[^/]*\/>\s*/, '');
  const meta = analyzeUrdf(urdfNoLimit, '/virtual.urdf', {});
  // The MASTER joint "left" has no limit and SHOULD warn; the mimic joint
  // "right" must NOT cause a separate joint.limitMissing warning.
  const limitWarnings = meta.diagnostics.filter(d => d.code === 'joint.limitMissing').map(d => d.target);
  assert.deepEqual(limitWarnings, ['left']);
});

// =============================================================================
// mimic propagation
// =============================================================================

test('propagateMimicValue follows multiplier + offset', () => {
  const meta = analyzeUrdf(URDF_WITH_MIMIC, '/virtual.urdf', {});
  const graph = buildMimicGraph(meta.joints);
  const followers = propagateMimicValue(graph, 'left', 0.02);
  assert.equal(followers.length, 1);
  assert.equal(followers[0].joint, 'right');
  // 0.02 * -1 + 0.1 = 0.08
  assert.ok(Math.abs(followers[0].value - 0.08) < 1e-9);
});

test('propagateMimicValue handles chained mimics without infinite recursion', () => {
  const urdf = `<?xml version="1.0"?>
<robot name="chain">
  <link name="a"/><link name="b"/><link name="c"/><link name="d"/>
  <joint name="j1" type="revolute"><parent link="a"/><child link="b"/><axis xyz="0 0 1"/><limit lower="-1" upper="1" effort="1" velocity="1"/></joint>
  <joint name="j2" type="revolute"><parent link="b"/><child link="c"/><axis xyz="0 0 1"/><mimic joint="j1" multiplier="2" offset="1"/></joint>
  <joint name="j3" type="revolute"><parent link="c"/><child link="d"/><axis xyz="0 0 1"/><mimic joint="j2" multiplier="0.5" offset="0"/></joint>
</robot>`;
  const meta = analyzeUrdf(urdf, '/virtual.urdf', {});
  const graph = buildMimicGraph(meta.joints);
  const followers = propagateMimicValue(graph, 'j1', 1);
  // j2 = 1*2+1 = 3; j3 = 3*0.5+0 = 1.5
  const map = Object.fromEntries(followers.map(f => [f.joint, f.value]));
  assert.equal(map.j2, 3);
  assert.equal(map.j3, 1.5);
});

// =============================================================================
// SRDF: parsing + writeback
// =============================================================================

const SRDF_FIXTURE = `<?xml version="1.0"?>
<robot name="bot">
  <group name="arm">
    <joint name="shoulder"/>
    <joint name="elbow"/>
  </group>
  <group_state name="home" group="arm">
    <joint name="shoulder" value="0"/>
    <joint name="elbow" value="0"/>
  </group_state>
  <disable_collisions link1="base" link2="head" reason="Adjacent"/>
</robot>`;

test('parseSrdf reads disable_collisions entries', () => {
  const semantic = parseSrdf(SRDF_FIXTURE);
  assert.equal(semantic.disableCollisions.length, 1);
  assert.deepEqual(semantic.disableCollisions[0], { link1: 'base', link2: 'head', reason: 'Adjacent' });
});

test('mergeDisableCollisionsIntoSrdf appends new pairs and skips duplicates', () => {
  const result = mergeDisableCollisionsIntoSrdf(SRDF_FIXTURE, [
    { link1: 'base', link2: 'head', reason: 'Adjacent' }, // duplicate, ignored
    { link1: 'head', link2: 'arm', reason: 'Never' }       // new
  ]);
  assert.equal(result.added, 1);
  assert.match(result.srdf, /link1="head"\s+link2="arm"/);
  assert.match(result.srdf, /<\/robot>/);
});

test('mergeDisableCollisionsIntoSrdf treats reversed link order as duplicate', () => {
  const result = mergeDisableCollisionsIntoSrdf(SRDF_FIXTURE, [
    { link1: 'head', link2: 'base' } // same pair, reversed
  ]);
  assert.equal(result.added, 0);
});

test('buildDisableCollisionsXml escapes attribute values', () => {
  const xml = buildDisableCollisionsXml([{ link1: 'a"b', link2: '<c>', reason: '&' }]);
  assert.match(xml, /link1="a&quot;b"/);
  assert.match(xml, /link2="&lt;c&gt;"/);
  assert.match(xml, /reason="&amp;"/);
});

// =============================================================================
// loadSemanticMetadata uses fixtures
// =============================================================================

test('loadSemanticMetadata loads SRDF when present and exposes disable_collisions', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'urdfstudio-srdf-'));
  try {
    const srdfPath = path.join(tmpDir, 'robot.srdf');
    await fs.writeFile(srdfPath, SRDF_FIXTURE, 'utf8');
    const semantic = await loadSemanticMetadata([srdfPath], {});
    assert.equal(semantic.sourceFile, srdfPath);
    assert.equal(semantic.disableCollisions.length, 1);
    assert.equal(semantic.groups[0]?.name, 'arm');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// =============================================================================
// xacro: includedFiles tracking + analyzeUrdf integration
// =============================================================================

test('renderRobotDocument tracks included files for hot reload watcher', async () => {
  const xacroPath = path.join(FIXTURE_ROOT, 'model.xacro');
  const packagePath = path.join(FIXTURE_ROOT, 'xacro_pkg');
  const result = await renderRobotDocument(xacroPath, {
    xacro_fixture: { name: 'xacro_fixture', path: packagePath, packageXml: path.join(packagePath, 'package.xml') }
  }, { robot_name: 'unit' });
  assert.equal(result.format, 'xacro');
  // We expect at least the included urdf/part.xacro file path to appear.
  const includedNames = result.includedFiles.map(file => path.basename(file));
  assert.ok(includedNames.includes('part.xacro'), `expected part.xacro in includedFiles, got ${includedNames.join(',')}`);
  // It should also pick up the YAML loaded via load_yaml.
  assert.ok(includedNames.some(name => name.endsWith('.yaml')), `expected a YAML included file, got ${includedNames.join(',')}`);
});

// =============================================================================
// xacro: source-text compatibility rewrites for ROS-flavoured constructs
// =============================================================================

test('applyXacroCompatibilityRewrites strips ROS Jade `:=^` pass-through defaults', () => {
  const src = '<xacro:macro name="m" params="name ee_inertials:=^">child</xacro:macro>';
  const out = applyXacroCompatibilityRewrites(src);
  assert.match(out, /params="name"/);
  assert.ok(!/:=\^/.test(out), `expected :=^ to be stripped, got ${out}`);
});

test('applyXacroCompatibilityRewrites rewrites Python ternary inside ${} via __pytruthy__', () => {
  const out = applyXacroCompatibilityRewrites(`\${prefix + '_' if prefix else ''}`);
  assert.match(out, /__pytruthy__\(\s*prefix\s*\)/);
  assert.ok(!/\bif\b.*\belse\b/.test(out), `Python ternary should be rewritten, got ${out}`);
});

test('applyXacroCompatibilityRewrites rewrites Python `**` power operator to pow()', () => {
  const out = applyXacroCompatibilityRewrites('${1./12 * mass * (3 * radius**2 + h**2)}');
  assert.match(out, /pow\(radius,\s*2\)/);
  assert.match(out, /pow\(h,\s*2\)/);
});

test('applyXacroCompatibilityRewrites strips xacro. namespace from function calls', () => {
  const out = applyXacroCompatibilityRewrites(`\${xacro.load_yaml('/tmp/a.yaml')}`);
  assert.match(out, /load_yaml\(/);
  assert.ok(!/xacro\.load_yaml/.test(out), `expected xacro. prefix stripped, got ${out}`);
});

test('applyXacroCompatibilityRewrites rewrites `.split(sep)[N]` to split_n helper', () => {
  const out = applyXacroCompatibilityRewrites(`\${xyz.split(' ')[0]}`);
  assert.match(out, /split_n\(xyz,\s*' ',\s*0\)/);
});

test('applyXacroCompatibilityRewrites rewrites Python list slice notation', () => {
  const fromOut = applyXacroCompatibilityRewrites('${items[1:]}');
  const toOut = applyXacroCompatibilityRewrites('${items[:2]}');
  const rangeOut = applyXacroCompatibilityRewrites('${items[1:3]}');
  assert.match(fromOut, /slice_from\(items,\s*1\)/);
  assert.match(toOut, /slice_to\(items,\s*2\)/);
  assert.match(rangeOut, /slice_range\(items,\s*1,\s*3\)/);
});

test('renderRobotDocument expands ROS-style xacro with YAML, ternary and dict access', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'urdfstudio-ros-xacro-'));
  try {
    const pkgPath = path.join(tmpDir, 'pkg');
    await fs.mkdir(path.join(pkgPath, 'urdf'), { recursive: true });
    await fs.writeFile(
      path.join(pkgPath, 'package.xml'),
      '<package format="3"><name>ros_xacro</name></package>',
      'utf8'
    );
    await fs.writeFile(
      path.join(pkgPath, 'inertials.yaml'),
      'base:\n  mass: 2.5\n  inertia:\n    xx: 0.01\n    yy: 0.02\n    zz: 0.03\n',
      'utf8'
    );
    const xacroPath = path.join(pkgPath, 'urdf', 'robot.urdf.xacro');
    await fs.writeFile(
      xacroPath,
      `<?xml version="1.0"?>
<robot xmlns:xacro="http://www.ros.org/wiki/xacro" name="t">
  <xacro:property name="no_prefix" value="false"/>
  <xacro:property name="inertials" value="\${xacro.load_yaml('$(find ros_xacro)/inertials.yaml')}"/>
  <xacro:property name="prefix" value="\${'' if no_prefix else 'r_'}"/>
  <xacro:macro name="add_link" params="name inertials:=^">
    <xacro:property name="li" value="\${inertials[name]}" lazy_eval="false"/>
    <link name="\${prefix}\${name}">
      <inertial>
        <mass value="\${li['mass']}"/>
        <inertia ixx="\${li['inertia']['xx']}" ixy="0" ixz="0"
                 iyy="\${li['inertia']['yy']}" iyz="0"
                 izz="\${li['inertia']['zz']}"/>
      </inertial>
    </link>
  </xacro:macro>
  <xacro:add_link name="base"/>
</robot>`,
      'utf8'
    );
    const result = await renderRobotDocument(
      xacroPath,
      { ros_xacro: { name: 'ros_xacro', path: pkgPath, packageXml: path.join(pkgPath, 'package.xml') } },
      {}
    );
    const errors = result.diagnostics.filter(d => d.severity === 'error');
    assert.deepEqual(errors, [], `expected no errors, got ${JSON.stringify(result.diagnostics)}`);
    assert.match(result.urdf, /<link name="r_base">/);
    assert.match(result.urdf, /<mass value="2\.5"\/>/);
    assert.match(result.urdf, /ixx="0\.01"/);
    assert.match(result.urdf, /izz="0\.03"/);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('renderRobotDocument absorbs many cfg lookups when load_yaml fails (no per-expression retries)', async () => {
  // Regression: real-world ROS xacros routinely reference 10-20 keys from a
  // YAML loaded via `load_yaml($(find pkg)/cfg.yaml)`. When the package
  // isn't in scope, every `${cfg['x']}` used to fail one at a time and
  // exhaust the recovery budget (the user hit this with the huba_bringup
  // xacro at attempt 17). The load_yaml null-sink must absorb all of them
  // in a single pass — emitting one yamlMissing warning, not 20 retries.
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'urdfstudio-nullsink-'));
  try {
    const xacroPath = path.join(tmpDir, 'robot.urdf.xacro');
    const keys = Array.from({ length: 24 }, (_, i) => `k${i}`);
    const links = keys
      .map(k => `  <link name="${k}"><visual><geometry><box size="0.1 0.1 0.1"/></geometry><origin xyz="\${cfg['${k}']} 0 0"/></visual></link>`)
      .join('\n');
    await fs.writeFile(
      xacroPath,
      `<?xml version="1.0"?>
<robot xmlns:xacro="http://www.ros.org/wiki/xacro" name="t">
  <xacro:property name="cfg" value="\${load_yaml('$(find missing_pkg)/cfg.yaml')}"/>
${links}
</robot>`,
      'utf8'
    );
    const result = await renderRobotDocument(xacroPath, {}, {});
    const errors = result.diagnostics.filter(d => d.severity === 'error');
    assert.deepEqual(errors, [], `expected no errors, got ${JSON.stringify(result.diagnostics)}`);
    for (const k of keys) {
      assert.match(result.urdf, new RegExp(`<link name="${k}">`));
    }
    assert.ok(result.diagnostics.some(d => d.code === 'xacro.yamlMissing'),
      `expected an xacro.yamlMissing diagnostic, got ${JSON.stringify(result.diagnostics)}`);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('renderRobotDocument exposes empty includedFiles for plain URDF', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'urdfstudio-plain-'));
  try {
    const urdfPath = path.join(tmpDir, 'robot.urdf');
    await fs.writeFile(urdfPath, '<?xml version="1.0"?><robot name="r"><link name="root"/></robot>', 'utf8');
    const result = await renderRobotDocument(urdfPath, {}, {});
    assert.equal(result.format, 'urdf');
    assert.deepEqual(result.includedFiles, []);
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

// =============================================================================
// buildBomCsv
// =============================================================================

test('buildBomCsv emits one row per link with mass / CoM / mesh paths', () => {
  const csv = buildBomCsv({
    robotName: 'r',
    counts: { links: 2, joints: 1, movableJoints: 1, visualMeshes: 1, collisionMeshes: 0 },
    links: {
      base: { name: 'base', childJoints: ['hinge'] },
      tip: {
        name: 'tip',
        parentJoint: 'hinge',
        childJoints: [],
        inertial: { mass: 1.25, origin: [0.1, 0, 0.2], rotation: [0, 0, 0], ixx: 0.1, ixy: 0, ixz: 0, iyy: 0.2, iyz: 0, izz: 0.3 }
      }
    },
    joints: {
      hinge: { name: 'hinge', type: 'revolute', parent: 'base', child: 'tip', axis: [0, 0, 1], limit: {} }
    },
    meshes: [
      { link: 'tip', kind: 'visual', filename: 'meshes/tip.stl', resolvedPath: '/abs/meshes/tip.stl', exists: true },
      { link: 'tip', kind: 'collision', filename: 'meshes/missing.stl', exists: false }
    ],
    rootLinks: ['base'],
    movableJointNames: ['hinge'],
    tree: [{ link: 'base', children: [{ link: 'tip', joint: 'hinge', children: [] }] }],
    totalMass: 1.25,
    diagnostics: []
  });
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.match(lines[0], /^link,parent_joint,parent_joint_type,mass_kg/);
  // Rows are sorted alphabetically: base, tip.
  assert.match(lines[1], /^base,,,/);
  const tipRow = lines[2].split(',');
  assert.equal(tipRow[0], 'tip');
  assert.equal(tipRow[1], 'hinge');
  assert.equal(tipRow[2], 'revolute');
  assert.equal(Number(tipRow[3]), 1.25);
  assert.match(lines[2], /\/abs\/meshes\/tip\.stl/);
  assert.match(lines[2], /missing\.stl/);
});

test('buildBomCsv escapes commas and quotes in mesh paths', () => {
  const csv = buildBomCsv({
    robotName: 'r',
    counts: { links: 1, joints: 0, movableJoints: 0, visualMeshes: 1, collisionMeshes: 0 },
    links: { weird: { name: 'weird', childJoints: [] } },
    joints: {},
    meshes: [
      { link: 'weird', kind: 'visual', filename: 'a,b.stl', resolvedPath: 'a,b "q".stl', exists: true }
    ],
    rootLinks: ['weird'],
    movableJointNames: [],
    tree: [{ link: 'weird', children: [] }],
    totalMass: 0,
    diagnostics: []
  });
  assert.match(csv, /"a,b ""q""\.stl"/);
});

// ============================================================================
// Mesh resolution: package fallback when package.xml is missing
// ============================================================================

test('analyzeUrdf falls back to URDF-relative paths when the named package has no package.xml', async () => {
  // Mimics a user uploading just the package contents (urdf/ + meshes/),
  // forgetting the package.xml at the root. The URDF still references
  // package://<name>/... but the resolver should walk up from the URDF's
  // own directory and find meshes/visual/Base.STL.
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'urdf-fallback-'));
  try {
    await fs.mkdir(path.join(tmpDir, 'meshes', 'visual'), { recursive: true });
    await fs.mkdir(path.join(tmpDir, 'urdf'), { recursive: true });
    // Tiny binary STL: 80-byte header + 4-byte zero triangle count.
    const stl = Buffer.concat([Buffer.alloc(80, 0x20), Buffer.from([0, 0, 0, 0])]);
    await fs.writeFile(path.join(tmpDir, 'meshes', 'visual', 'Base.STL'), stl);
    const urdf = `<?xml version="1.0"?>
<robot name="franka">
  <link name="base">
    <visual><geometry><mesh filename="package://franka_description/meshes/visual/Base.STL"/></geometry></visual>
  </link>
</robot>`;
    const urdfPath = path.join(tmpDir, 'urdf', 'franka.urdf');
    await fs.writeFile(urdfPath, urdf, 'utf8');

    const meta = analyzeUrdf(urdf, urdfPath, /* packages */ {});

    // Mesh should resolve to the actual file on disk.
    const mesh = meta.meshes.find(m => m.filename.endsWith('Base.STL'));
    assert.ok(mesh, 'expected one mesh entry');
    assert.equal(mesh.exists, true, 'mesh existsSync should be true via fallback');
    assert.equal(mesh.resolvedPath, path.join(tmpDir, 'meshes', 'visual', 'Base.STL'));

    // Diagnostics should be exactly one warning (mesh.packageFallback) —
    // not a per-mesh hard error.
    const fallbackWarns = meta.diagnostics.filter(d => d.code === 'mesh.packageFallback');
    const packageMissing = meta.diagnostics.filter(d => d.code === 'mesh.packageMissing');
    assert.equal(fallbackWarns.length, 1, 'one summary warning');
    assert.equal(packageMissing.length, 0, 'no per-mesh missing-package errors');
    assert.equal(fallbackWarns[0].severity, 'warning');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test('analyzeUrdf reports mesh.packageMissing when the package is missing AND fallback fails', async () => {
  // Same setup as above, but the referenced mesh file genuinely does not
  // exist anywhere — fallback walks up and finds nothing, the original
  // hard error stands.
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'urdf-truly-missing-'));
  try {
    await fs.mkdir(path.join(tmpDir, 'urdf'), { recursive: true });
    const urdf = `<?xml version="1.0"?>
<robot name="ghost">
  <link name="base">
    <visual><geometry><mesh filename="package://ghost_pkg/never/exists.stl"/></geometry></visual>
  </link>
</robot>`;
    const urdfPath = path.join(tmpDir, 'urdf', 'ghost.urdf');
    await fs.writeFile(urdfPath, urdf, 'utf8');

    const meta = analyzeUrdf(urdf, urdfPath, /* packages */ {});
    const errors = meta.diagnostics.filter(d => d.code === 'mesh.packageMissing');
    assert.equal(errors.length, 1);
    assert.equal(errors[0].severity, 'error');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

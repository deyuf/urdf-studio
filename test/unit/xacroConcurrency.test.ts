import { strict as assert } from 'node:assert';
import test from 'node:test';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import '../../src/core/io.node';
import { renderRobotDocument } from '../../src/core/xacro';

async function makeXacroFixture(rootName: string, basis = ''): Promise<{ dir: string; xacroPath: string; cleanup: () => Promise<void> }> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), `urdfstudio-xc-${rootName}-`));
  const xacroPath = path.join(dir, 'robot.xacro');
  await fs.writeFile(
    xacroPath,
    `<?xml version="1.0"?>
<robot xmlns:xacro="http://www.ros.org/wiki/xacro" name="r${rootName}">
  <xacro:property name="size" value="0.5"/>
  <link name="${basis || rootName}">
    <visual><geometry><box size="\${size} \${size} \${size}"/></geometry></visual>
  </link>
</robot>`,
    'utf8'
  );
  return { dir, xacroPath, cleanup: async () => fs.rm(dir, { recursive: true, force: true }) };
}

test('renderRobotDocument does NOT mutate globalThis.DOMParser after success', async () => {
  const { xacroPath, cleanup } = await makeXacroFixture('one');
  const before = (globalThis as { DOMParser?: unknown }).DOMParser;
  try {
    await renderRobotDocument(xacroPath, {}, {});
    const after = (globalThis as { DOMParser?: unknown }).DOMParser;
    assert.equal(after, before, 'globalThis.DOMParser must remain whatever it was before');
  } finally {
    await cleanup();
  }
});

test('renderRobotDocument does NOT mutate globalThis.XMLSerializer either', async () => {
  // Companion to the DOMParser test: the legacy implementation swapped both
  // globals in tandem, so we cover the second symbol as well.
  const { xacroPath, cleanup } = await makeXacroFixture('xs');
  const before = (globalThis as { XMLSerializer?: unknown }).XMLSerializer;
  try {
    await renderRobotDocument(xacroPath, {}, {});
    const after = (globalThis as { XMLSerializer?: unknown }).XMLSerializer;
    assert.equal(after, before, 'globalThis.XMLSerializer must remain whatever it was before');
  } finally {
    await cleanup();
  }
});

test('concurrent renderRobotDocument calls produce correct, non-interleaved outputs', async () => {
  // Spin up multiple xacro fixtures, each declaring a different link name.
  // Without serialisation the vendored parser could (in theory) interleave
  // global state across runs. With the lock + injected DOMParser every
  // promise should resolve to the URDF its own fixture declared.
  const fixtures = await Promise.all([
    makeXacroFixture('a', 'link_a'),
    makeXacroFixture('b', 'link_b'),
    makeXacroFixture('c', 'link_c'),
    makeXacroFixture('d', 'link_d')
  ]);

  try {
    const results = await Promise.all(fixtures.map(f => renderRobotDocument(f.xacroPath, {}, {})));
    assert.match(results[0].urdf, /<link name="link_a"/);
    assert.match(results[1].urdf, /<link name="link_b"/);
    assert.match(results[2].urdf, /<link name="link_c"/);
    assert.match(results[3].urdf, /<link name="link_d"/);
    for (const r of results) {
      assert.equal(r.format, 'xacro');
      assert.deepEqual(r.diagnostics.filter(d => d.severity === 'error'), []);
    }
  } finally {
    await Promise.all(fixtures.map(f => f.cleanup()));
  }
});

test('xacro expression recovery warning fires for an unresolvable expression', async () => {
  // Drives the parseXacroWithRecovery path: the expression `bad_fn(x)` is
  // unknown, so the parser throws "Failed to process expression ..." and our
  // recovery loop catches it, emitting an `xacro.expressionSkipped` warning.
  // We don't assert on the resulting URDF shape (the parser may or may not
  // resurrect a useful tree after the expression is erased — that's a
  // best-effort path). We only assert that:
  //   1. a warning was emitted, and
  //   2. the literal text `bad_fn(x)` survived elsewhere (it appears as a
  //      child link name suffix, so if the old `split().join('')` were back
  //      it would have erased it too).
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'urdfstudio-xc-rec-'));
  const xacroPath = path.join(tmp, 'r.xacro');
  await fs.writeFile(
    xacroPath,
    `<?xml version="1.0"?>
<robot xmlns:xacro="http://www.ros.org/wiki/xacro" name="r">
  <link name="\${bad_fn(x)}"/>
  <link name="x_bad_fn_x_marker"/>
</robot>`,
    'utf8'
  );
  try {
    const result = await renderRobotDocument(xacroPath, {}, {});
    const skipped = result.diagnostics.filter(d => d.code === 'xacro.expressionSkipped');
    assert.ok(skipped.length >= 1, `expected expressionSkipped, got ${JSON.stringify(result.diagnostics)}`);
    // The marker link's literal name is fine — the scoped sanitiser must
    // not touch text outside ${...} blocks.
    assert.match(result.urdf, /x_bad_fn_x_marker/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

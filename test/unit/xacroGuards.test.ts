import { strict as assert } from 'node:assert';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import '../../src/core/io.node';
import { renderXacroFile } from '../../src/core/xacro';

const HEADER = '<?xml version="1.0"?>\n<robot name="r" xmlns:xacro="http://www.ros.org/wiki/xacro">';

async function workspace(files: Record<string, string>): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'urdfstudio-guard-'));
  for (const [name, body] of Object.entries(files)) {
    await fs.writeFile(path.join(dir, name), `${HEADER}${body}</robot>`);
  }
  return dir;
}

async function render(dir: string, name: string) {
  const file = path.join(dir, name);
  const content = await fs.readFile(file, 'utf8');
  return renderXacroFile(file, content, {}, {});
}

/** Fail the test instead of hanging the runner if a guard regresses. */
function within<T>(ms: number, work: Promise<T>): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`did not finish within ${ms} ms`)), ms))
  ]);
}

test('an include cycle is reported instead of hanging', async () => {
  const dir = await workspace({
    'a.xacro': '<xacro:include filename="b.xacro"/>',
    'b.xacro': '<xacro:include filename="./a.xacro"/>'
  });
  const result = await within(5000, render(dir, 'a.xacro'));
  const messages = result.diagnostics.map(d => d.message).join('\n');
  assert.match(messages, /Include cycle/);
});

test('a file that includes itself is reported', async () => {
  const dir = await workspace({ 'self.xacro': '<xacro:include filename="self.xacro"/>' });
  const result = await within(5000, render(dir, 'self.xacro'));
  assert.ok(result.diagnostics.some(d => /Include cycle/.test(d.message)));
});

test('the same file included twice in sequence is not a cycle', async () => {
  const dir = await workspace({
    'main.xacro': '<xacro:include filename="part.xacro"/><xacro:include filename="part.xacro"/><link name="base"/>',
    'part.xacro': '<xacro:property name="w" value="1"/>'
  });
  const result = await within(5000, render(dir, 'main.xacro'));
  assert.ok(!result.diagnostics.some(d => /Include cycle/.test(d.message)));
  assert.match(result.urdf, /<link name="base"\/>/);
});

test('runaway macro recursion stops with a diagnostic', async () => {
  const dir = await workspace({
    'loop.xacro': '<xacro:macro name="m" params=""><link name="x"/><xacro:m/></xacro:macro><xacro:m/>'
  });
  const result = await within(10000, render(dir, 'loop.xacro'));
  assert.ok(result.diagnostics.some(d => /calls itself too deeply/.test(d.message)));
});

test('bounded recursion still expands', async () => {
  const dir = await workspace({
    'chain.xacro': `
      <xacro:macro name="seg" params="n">
        <link name="l\${n}"/>
        <xacro:if value="\${n > 0}"><xacro:seg n="\${n - 1}"/></xacro:if>
      </xacro:macro>
      <xacro:seg n="20"/>`
  });
  const result = await within(10000, render(dir, 'chain.xacro'));
  assert.equal((result.urdf.match(/<link name="l\d+"\/>/g) ?? []).length, 21);
});

test('a render after a failed one is not blocked', async () => {
  const dir = await workspace({
    'bad.xacro': '<xacro:include filename="bad.xacro"/>',
    'ok.xacro': '<link name="fine"/>'
  });
  await within(5000, render(dir, 'bad.xacro'));
  const result = await within(5000, render(dir, 'ok.xacro'));
  assert.match(result.urdf, /<link name="fine"\/>/);
});

test('an empty or non-XML robot file is reported, not rendered as text', async () => {
  for (const content of ['', 'hello']) {
    const result = await within(5000, renderXacroFile('/tmp/x.xacro', content, {}, {}));
    assert.ok(result.diagnostics.some(d => /not valid XML/.test(d.message)), JSON.stringify(content));
  }
});

test('an empty included file is reported instead of being spliced into the robot', async () => {
  const dir = await workspace({ 'main.xacro': '<link name="a"/><xacro:include filename="empty.xacro"/>' });
  await fs.writeFile(path.join(dir, 'empty.xacro'), '');
  const result = await within(5000, render(dir, 'main.xacro'));
  assert.ok(result.diagnostics.some(d => /Included file .*empty\.xacro is not valid XML/.test(d.message)));
  assert.doesNotMatch(result.urdf, /root element/);
});

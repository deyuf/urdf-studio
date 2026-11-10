import { strict as assert } from 'node:assert';
import test from 'node:test';
import '../../src/core/io.node';
import { analyzeUrdf } from '../../src/core/urdfAnalysis';
import { buildBomCsv } from '../../src/core/bom';
import { runAllRules } from '../../src/core/lintRules';
import { lineAtOffset, lineForNeedle } from '../../src/core/xml';

function timed<T>(work: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = work();
  return { value, ms: performance.now() - start };
}

test('text that merely starts with -<digit> is guarded against formula injection', () => {
  const meta = analyzeUrdf('<robot name="r"><link name="-1+1|cmd"/><link name="=sum"/></robot>', '/r.urdf', {});
  const csv = buildBomCsv(meta);
  assert.match(csv, /^'-1\+1\|cmd,/m);
  assert.match(csv, /^'=sum,/m);
});

test('line lookups count lines exactly, across documents and CRLF', () => {
  const text = 'a\nb\r\nneedle\nc';
  assert.equal(lineForNeedle(text, 'needle'), 3);
  assert.equal(lineForNeedle(text, 'a'), 1);
  assert.equal(lineForNeedle(text, 'missing'), undefined);
  assert.equal(lineAtOffset(text, text.length), 4);
  // A different document must not reuse the previous index.
  assert.equal(lineForNeedle('x\ny\nneedle', 'needle'), 3);
});

test('analysis of a 10,000-link robot stays fast', () => {
  let body = '';
  for (let i = 0; i < 10000; i += 1) {
    body += `<link name="l${i}"/>\n`;
  }
  const { value, ms } = timed(() => analyzeUrdf(`<robot name="r">\n${body}</robot>`, '/r.urdf', {}));
  assert.equal(value.links.l9999.line, 10001);
  assert.ok(ms < 3000, `took ${ms.toFixed(0)} ms`);
});

test('pathological expression and mesh text does not make checks crawl', () => {
  const nested = `<robot name="r"><link name="${'${'.repeat(60000)}"/></robot>`;
  const meshes = `<robot name="r"><!--${'<mesh '.repeat(30000)}--><link name="a"/></robot>`;
  for (const urdf of [nested, meshes]) {
    const metadata = analyzeUrdf(urdf, '/r.urdf', {});
    const { ms } = timed(() => runAllRules({ urdf, sourcePath: '/r.urdf', packages: {}, metadata }));
    assert.ok(ms < 1500, `took ${ms.toFixed(0)} ms`);
  }
});

test('division by zero and unit-scale checks still fire', () => {
  const urdf = '<robot name="r"><link name="a"><visual><geometry><mesh filename="a.stl" scale="0.001 0.001 0.001"/></geometry></visual>'
    + '<visual><geometry><mesh filename="b.stl" scale="1 1 1"/></geometry></visual></link>'
    + '<link name="${x / 0}"/></robot>';
  const metadata = analyzeUrdf(urdf, '/r.urdf', {});
  const report = runAllRules({ urdf, sourcePath: '/r.urdf', packages: {}, metadata });
  assert.ok(report.byRule['S-004'], 'S-004');
  assert.ok(report.byRule['A-003'], 'A-003');
});

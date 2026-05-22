import { strict as assert } from 'node:assert';
import test from 'node:test';
import { escapeHtml, html, raw, TrustedHtml } from '../../src/renderer/html';

test('escapeHtml encodes the five XSS-relevant HTML metacharacters', () => {
  assert.equal(escapeHtml('a&b'), 'a&amp;b');
  assert.equal(escapeHtml('a<b>'), 'a&lt;b&gt;');
  assert.equal(escapeHtml('a"b'), 'a&quot;b');
  assert.equal(escapeHtml("a'b"), 'a&#39;b');
});

test('escapeHtml renders null/undefined as empty string', () => {
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('escapeHtml stringifies non-string values', () => {
  assert.equal(escapeHtml(42), '42');
  assert.equal(escapeHtml(true), 'true');
});

test('escapeHtml is a no-op on benign text', () => {
  assert.equal(escapeHtml('hello world 123'), 'hello world 123');
});

// =============================================================================
// html`...`
// =============================================================================

test('html`...` returns a TrustedHtml', () => {
  const result = html`<div>plain</div>`;
  assert.ok(result instanceof TrustedHtml);
  assert.equal(result.value, '<div>plain</div>');
});

test('html interpolations are escaped by default', () => {
  const userPayload = '<script>alert(1)</script>';
  const out = html`<p>${userPayload}</p>`;
  assert.equal(out.value, '<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>');
});

test('html interpolations escape inside attributes too', () => {
  const linkName = 'link"><script>evil()</script>';
  const out = html`<div data-link="${linkName}"></div>`;
  // The escaped quote breaks out the attribute safely.
  assert.ok(out.value.includes('data-link="link&quot;'), `actual: ${out.value}`);
  assert.ok(!out.value.includes('<script>'), 'must not allow script injection in attribute');
});

test('html interpolations escape ampersands', () => {
  const out = html`<a href="?q=${'a&b'}">x</a>`;
  assert.equal(out.value, '<a href="?q=a&amp;b">x</a>');
});

test('nested html`...` results pass through unescaped (composition)', () => {
  const inner = html`<em>${'bold & beautiful'}</em>`;
  const outer = html`<p>${inner}</p>`;
  assert.equal(outer.value, '<p><em>bold &amp; beautiful</em></p>');
});

test('arrays of html`...` are joined verbatim', () => {
  const items = ['a', 'b', 'c'].map(item => html`<li>${item}</li>`);
  const out = html`<ul>${items}</ul>`;
  assert.equal(out.value, '<ul><li>a</li><li>b</li><li>c</li></ul>');
});

test('array of plain strings inside html is element-wise escaped', () => {
  const items = ['<a>', '<b>'];
  const out = html`<p>${items}</p>`;
  assert.equal(out.value, '<p>&lt;a&gt;&lt;b&gt;</p>');
});

test('false / null / undefined interpolations render as empty string', () => {
  assert.equal(html`a${false}b`.value, 'ab');
  assert.equal(html`a${null}b`.value, 'ab');
  assert.equal(html`a${undefined}b`.value, 'ab');
});

test('numeric interpolations are stringified, not escaped away', () => {
  const out = html`<div data-count=${42}>${0}</div>`;
  assert.equal(out.value, '<div data-count=42>0</div>');
});

// =============================================================================
// raw escape hatch
// =============================================================================

test('raw() wraps a string as TrustedHtml', () => {
  const trusted = raw('<svg></svg>');
  assert.ok(trusted instanceof TrustedHtml);
  assert.equal(trusted.value, '<svg></svg>');
});

test('raw() interpolations are NOT escaped in html`...`', () => {
  const out = html`<div>${raw('<b>bold</b>')}</div>`;
  assert.equal(out.value, '<div><b>bold</b></div>');
});

// =============================================================================
// XSS regression scenarios from URDF input
// =============================================================================

test('XSS regression: a link name containing markup cannot break out of attribute context', () => {
  // Simulate what could come from a malicious URDF: <link name="x" onerror="evil()"...
  const linkName = 'x" onerror="alert(1)';
  const out = html`<button data-link="${linkName}">click</button>`;
  // The dangerous closing quote+attribute is encoded.
  assert.match(out.value, /data-link="x&quot; onerror=&quot;alert\(1\)"/);
});

test('XSS regression: a mesh path containing tags is encoded in text context', () => {
  const meshPath = 'meshes/<script>alert(1)</script>.stl';
  const out = html`<span>${meshPath}</span>`;
  assert.equal(out.value, '<span>meshes/&lt;script&gt;alert(1)&lt;/script&gt;.stl</span>');
});

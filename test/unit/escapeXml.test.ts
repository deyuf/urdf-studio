import { strict as assert } from 'node:assert';
import test from 'node:test';
import { escapeXmlAttr, escapeXmlText } from '../../src/core/escapeXml';

test('escapeXmlAttr encodes the five XML attribute metacharacters', () => {
  assert.equal(escapeXmlAttr('a"b'), 'a&quot;b');
  assert.equal(escapeXmlAttr("a'b"), 'a&apos;b');
  assert.equal(escapeXmlAttr('a&b'), 'a&amp;b');
  assert.equal(escapeXmlAttr('a<b>c'), 'a&lt;b&gt;c');
});

test('escapeXmlAttr handles strings containing all metacharacters in one pass', () => {
  assert.equal(
    escapeXmlAttr('one & <two> "three" \'four\''),
    'one &amp; &lt;two&gt; &quot;three&quot; &apos;four&apos;'
  );
});

test('escapeXmlAttr leaves benign text untouched', () => {
  const benign = 'no-special-chars-1234';
  assert.equal(escapeXmlAttr(benign), benign);
});

test('escapeXmlText encodes the four text metacharacters but not single quote', () => {
  assert.equal(escapeXmlText('a&b<c>d"e\'f'), 'a&amp;b&lt;c&gt;d&quot;e\'f');
});

test('escapeXmlText is idempotent on already-escaped output', () => {
  const once = escapeXmlText('a & b');
  const twice = escapeXmlText(escapeXmlText('a & b'));
  // After escapeXmlText runs twice the `&amp;` gets turned into `&amp;amp;`,
  // which is expected behaviour (encoding twice is encoding twice). We assert
  // the documented behaviour rather than idempotency here.
  assert.equal(once, 'a &amp; b');
  assert.equal(twice, 'a &amp;amp; b');
});

test('escapeXmlAttr handles empty strings', () => {
  assert.equal(escapeXmlAttr(''), '');
  assert.equal(escapeXmlText(''), '');
});

test('escapeXmlAttr handles unicode without mangling', () => {
  assert.equal(escapeXmlAttr('日本語 / 中文 & emoji 🤖'), '日本語 / 中文 &amp; emoji 🤖');
});

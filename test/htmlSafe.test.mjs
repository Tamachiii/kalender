// Tests for the two render-time safety helpers. The bigger picture: tags and
// calendar colors flow from the database into HTML `style` attributes. Without
// safeColor, a malicious string from a calendar collaborator becomes stored XSS.
// The DB CHECK constraint added in 2026-05-color-format-check.sql is one
// layer; safeColor is the other.
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { DEFAULT_SAFE_COLOR, escapeHtml, safeColor } from '../js/htmlSafe.js';

test('escapeHtml — replaces every script-relevant character', () => {
  assert.equal(escapeHtml('<script>alert(1)</script>'), '&lt;script&gt;alert(1)&lt;/script&gt;');
  assert.equal(escapeHtml('a & b'), 'a &amp; b');
  assert.equal(escapeHtml('"quoted"'), '&quot;quoted&quot;');
  assert.equal(escapeHtml("o'clock"), 'o&#039;clock');
});

test('escapeHtml — coerces non-strings safely', () => {
  assert.equal(escapeHtml(42), '42');
  assert.equal(escapeHtml(null), 'null');
  assert.equal(escapeHtml(undefined), 'undefined');
});

test('safeColor — accepts canonical 6-digit hex (lower and upper case)', () => {
  assert.equal(safeColor('#92c5fc'), '#92c5fc');
  assert.equal(safeColor('#FFFFFF'), '#FFFFFF');
  assert.equal(safeColor('#0a0B0c'), '#0a0B0c');
});

test('safeColor — rejects anything else and returns the fallback', () => {
  // The malicious payload that motivated this whole helper:
  const xss = '#000"></span><script>alert(1)</script>';
  assert.equal(safeColor(xss), DEFAULT_SAFE_COLOR);

  // Other shapes that don't match strict 6-digit hex:
  assert.equal(safeColor('#abc'), DEFAULT_SAFE_COLOR);
  assert.equal(safeColor('red'), DEFAULT_SAFE_COLOR);
  assert.equal(safeColor('rgb(0,0,0)'), DEFAULT_SAFE_COLOR);
  assert.equal(safeColor('#92c5fc; background: url(x)'), DEFAULT_SAFE_COLOR);
  assert.equal(safeColor(''), DEFAULT_SAFE_COLOR);
  assert.equal(safeColor(null), DEFAULT_SAFE_COLOR);
  assert.equal(safeColor(undefined), DEFAULT_SAFE_COLOR);
});

test('safeColor — caller-supplied fallback wins over the default', () => {
  assert.equal(safeColor('not-a-color', '#92c5fc'), '#92c5fc');
});

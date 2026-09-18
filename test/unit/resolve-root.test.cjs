const test = require('node:test');
const assert = require('node:assert');

/*
 * Guards the URL-encoding bug that broke every macOS install: CEP serves the
 * page over file://, so the path contains %20 for the space in
 * "Application Support" and a relative require() can never resolve.
 */

function decodeRoot(pathname) {
  let decoded;
  try { decoded = decodeURIComponent(pathname); } catch (e) { decoded = pathname; }
  if (/\.html?$/i.test(decoded)) decoded = decoded.replace(/\/[^/]*$/, '');
  return decoded;
}

test('a %20-encoded CEP path decodes to the real directory', () => {
  assert.strictEqual(
    decodeRoot('/Users/x/Library/Application%20Support/Adobe/CEP/extensions/com.aemcpvision.bridge/index.html'),
    '/Users/x/Library/Application Support/Adobe/CEP/extensions/com.aemcpvision.bridge',
  );
});

test('the document name is trimmed for either entry page', () => {
  assert.strictEqual(decodeRoot('/a/b/server.html'), '/a/b');
  assert.strictEqual(decodeRoot('/a/b/index.html'), '/a/b');
});

test('an already-decoded path is left alone', () => {
  assert.strictEqual(decodeRoot('/Users/x/Application Support/ext/index.html'), '/Users/x/Application Support/ext');
});

test('a malformed escape does not throw', () => {
  assert.doesNotThrow(() => decodeRoot('/bad/%E0%A4%A/index.html'));
});

test('other encoded characters decode too', () => {
  assert.strictEqual(decodeRoot('/a/My%20Ext%20v2/index.html'), '/a/My Ext v2');
});

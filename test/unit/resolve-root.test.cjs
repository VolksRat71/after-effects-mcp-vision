const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const url = require('node:url');

/*
 * How the entry pages find their own folder: path.dirname(fileURLToPath(href)).
 *
 * Two platform bugs lived here. macOS: CEP serves pages over file://, so
 * "Application Support" arrives as %20 and a naive path never resolves. Windows:
 * the URL pathname is "/C:/Users/...", and the old strip-the-filename approach
 * handed path.join "/C:/..." -> "\C:\...", so no Windows install ever booted -
 * found on the first real Windows run. fileURLToPath handles both.
 *
 * The real runtime converts with the host platform's rules. To test Windows
 * rules from macOS/Linux CI, pass { windows: true }, which Node added in 22.1 /
 * 20.13; on older Node the Windows cases skip rather than pass vacuously.
 */

const WIN_SUPPORTED = url.fileURLToPath('file:///C:/x', { windows: true }) === 'C:\\x';

function rootFor(href, windows) {
  const p = windows ? path.win32 : path.posix;
  return p.dirname(url.fileURLToPath(href.split(/[?#]/)[0], { windows }));
}

test('macOS: %20 in "Application Support" decodes to the real folder', () => {
  assert.strictEqual(
    rootFor('file:///Users/x/Library/Application%20Support/Adobe/CEP/extensions/com.aemcpvision.bridge/index.html', false),
    '/Users/x/Library/Application Support/Adobe/CEP/extensions/com.aemcpvision.bridge',
  );
});

test('Windows: the drive letter survives, with no leading slash', { skip: !WIN_SUPPORTED && 'needs Node 20.13+/22.1+' }, () => {
  const root = rootFor('file:///C:/Users/natha/AppData/Roaming/Adobe/CEP/extensions/com.aemcpvision.bridge/server.html', true);
  assert.strictEqual(root, 'C:\\Users\\natha\\AppData\\Roaming\\Adobe\\CEP\\extensions\\com.aemcpvision.bridge');
  assert.ok(path.win32.isAbsolute(root));
  // The exact value that broke every Windows install:
  assert.notStrictEqual(path.win32.join(root, 'client', 'server-boot.js')[0], '\\');
});

test('Windows: %20 decodes too', { skip: !WIN_SUPPORTED && 'needs Node 20.13+/22.1+' }, () => {
  assert.strictEqual(rootFor('file:///C:/My%20Ext/index.html', true), 'C:\\My Ext');
});

test('a query or hash on the URL does not leak into the path', () => {
  assert.strictEqual(rootFor('file:///a/b/index.html?x=1#y', false), '/a/b');
});

test('the old strip-the-filename approach really did break Windows', { skip: !WIN_SUPPORTED && 'needs Node 20.13+/22.1+' }, () => {
  const pathname = '/C:/Users/natha/ext/server.html';
  const oldRoot = decodeURIComponent(pathname).replace(/\/[^/]*$/, '');
  assert.strictEqual(path.win32.join(oldRoot, 'client', 'server-boot.js'), '\\C:\\Users\\natha\\ext\\client\\server-boot.js');
});

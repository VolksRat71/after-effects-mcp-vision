// Must be set BEFORE requiring http-server, which resolves the token path at
// module load. Without this the suite writes to (and deletes) the real token.
process.env.AE_MCP_TOKEN_DIR = require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'ae-mcp-test-'),
);

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..');
const buildScript = fs.readFileSync(path.join(ROOT, 'scripts/build-zxp.sh'), 'utf8');

test('the package excludes .debug, which opens remote-debugging ports', () => {
  assert.match(buildScript, /--exclude='\.debug'/);
});

test('signing is optional so a fork without secrets still builds', () => {
  assert.match(buildScript, /UNSIGNED/);
});

test('the extension ships no node_modules', () => {
  assert.strictEqual(fs.existsSync(path.join(ROOT, 'cep', 'node_modules')), false,
    'cep/ must stay dependency-free - CEP ships Node v17, below what most SDKs need');
});

test('the manifest floor is AE 22.0, where Layer.id was introduced', () => {
  const manifest = fs.readFileSync(path.join(ROOT, 'cep/CSXS/manifest.xml'), 'utf8');
  assert.match(manifest, /Version="\[22\.0,/,
    'stable layer ids are the basis of all addressing; below 22.0 there are none');
});

test('the manifest declares both the headless server and the panel', () => {
  const manifest = fs.readFileSync(path.join(ROOT, 'cep/CSXS/manifest.xml'), 'utf8');
  assert.match(manifest, /com\.aemcpvision\.bridge\.server/);
  assert.match(manifest, /com\.aemcpvision\.bridge\.panel/);
  assert.match(manifest, /<Type>Custom<\/Type>/, 'the server extension must be headless');
  assert.match(manifest, /ApplicationActivate/, 'the server must auto-start with After Effects');
});

test('verify-live.sh reads the same token path the server writes', () => {
  const script = fs.readFileSync(path.join(ROOT, 'test/verify-live.sh'), 'utf8');
  const server = fs.readFileSync(path.join(ROOT, 'cep/server/http-server.js'), 'utf8');
  const usesHome = /\.ae-mcp-vision/.test(script) && /homedir\(\)/.test(server);
  assert.ok(usesHome, 'the live verifier drifted from the server token location');
  assert.doesNotMatch(script, /tmpdir/,
    'verify-live.sh must not read the old temp-dir token path');
});

test('Gatekeeper instructions match modern macOS, where right-click Open was removed', () => {
  for (const f of ['docs/INSTALL.md', '.github/RELEASE_TEMPLATE.md']) {
    const doc = fs.readFileSync(path.join(ROOT, f), 'utf8');
    assert.match(doc, /Open Anyway/,
      `${f} must tell macOS 15+ users to use System Settings > Privacy & Security`);
    assert.match(doc, /System Settings/, `${f} must name where the bypass lives`);
    assert.match(doc, /administrator|admin password/i,
      `${f} must state that macOS 15+ asks for an admin password - "no admin needed" is only true of the install destination`);
  }
});

/*
 * The manifest is what CEP and extension managers report as the installed
 * version. Only the .zxp build used to stamp it, so every .dmg and .exe
 * reported "2.0.0" regardless of the release - noticed when an installed 2.0.2
 * claimed to be 2.0.0. The release workflow runs this suite before building,
 * so a drifted tag cannot ship.
 */
test('manifest versions match package.json', () => {
  const { version } = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const xml = fs.readFileSync(path.join(ROOT, 'cep', 'CSXS', 'manifest.xml'), 'utf8');
  const bundle = xml.match(/ExtensionBundleVersion="([^"]+)"/)[1];
  const exts = [...xml.matchAll(/<Extension Id="[^"]+"\s+Version="([^"]+)"/g)].map((m) => m[1]);
  assert.strictEqual(bundle, version, 'ExtensionBundleVersion drifted - run: node scripts/sync-version.mjs');
  assert.ok(exts.length >= 2, 'expected the server and panel extension entries');
  for (const v of exts) assert.strictEqual(v, version, 'an <Extension> Version drifted - run: node scripts/sync-version.mjs');
});

test('npm version keeps the manifest in step automatically', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.version || '', /sync-version\.mjs/,
    'the "version" lifecycle script must run sync-version.mjs so a bump cannot forget the manifest');
});

/*
 * /SUPPRESSMSGBOXES only answers boxes shown with SuppressibleMsgBox. A plain
 * MsgBox in [Code] made a silent install with After Effects open hang forever
 * on an invisible dialog.
 */
test('the Windows installer never shows a box that silent mode cannot answer', () => {
  const iss = fs.readFileSync(path.join(ROOT, 'scripts', 'installer', 'windows-installer.iss'), 'utf8');
  const code = iss.slice(iss.indexOf('[Code]'));
  const plain = code.split('\n').filter((l) => /(^|[^A-Za-z])MsgBox\s*\(/.test(l) && !/^\s*\/\//.test(l));
  assert.deepStrictEqual(plain, [], 'use SuppressibleMsgBox(..., IDOK) so /SUPPRESSMSGBOXES can answer it');
  assert.match(code, /SuppressibleMsgBox\(/);
});

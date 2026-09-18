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

test('the package stamps the manifest from package.json', () => {
  assert.match(buildScript, /ExtensionBundleVersion/);
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

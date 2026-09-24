const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { bridgeInfo } = require('../../cep/server/bridge-info.js');
const { createToolRegistry } = require('../../cep/server/tools.js');

/*
 * After the 2.0.4 reinstall a client kept the old ae_masks schema while the
 * server ran 2.0.4. Reporting the running version makes that visible.
 */
const ROOT = path.join(__dirname, '..', '..');

test('bridgeInfo reports the manifest version, and dev mode from a checkout', () => {
  const info = bridgeInfo();
  const manifest = fs.readFileSync(path.join(ROOT, 'cep', 'CSXS', 'manifest.xml'), 'utf8');
  assert.strictEqual(info.version, manifest.match(/ExtensionBundleVersion="([^"]+)"/)[1]);
  assert.strictEqual(info.mode, 'dev', 'a checkout has cep/.debug, which no package ships');
  assert.match(String(info.commit), /^[0-9a-f]{7}$/, 'dev mode says which commit is running');
});

test('sessionInfo carries the bridge version', async () => {
  const reg = createToolRegistry(async () => ({ ok: true, result: { aeVersion: '25.5', comps: [] } }));
  const out = JSON.parse((await reg.callTool('ae_query', { command: 'sessionInfo' })).content[0].text);
  assert.strictEqual(out.bridge.version, bridgeInfo().version);
  assert.strictEqual(out.aeVersion, '25.5', 'the host fields are kept');
});

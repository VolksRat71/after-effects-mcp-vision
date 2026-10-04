const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const path = require('node:path');
const os = require('node:os');
const { listResources, readResource, resolveDoc, RESOURCES } = require('../../cep/server/docs.js');
const { createMcpHandler } = require('../../cep/server/mcp.js');

const handler = createMcpHandler({ tools: [], callTool: async () => ({}) });
const rpc = (method, params) => handler(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));

test('every advertised resource actually exists on disk', () => {
  for (const r of RESOURCES) {
    assert.ok(fs.existsSync(resolveDoc(r.file)), `${r.uri} points at a missing file: ${r.file}`);
  }
});

/*
 * The packaged layout is <ext>/server/docs.js beside <ext>/docs/. Only the dev
 * layout (<repo>/docs, one level higher) used to be checked, so every release
 * answered every resource with "file is missing" while the dev checkout
 * looked fine. Build that packaged layout in a temp dir and read through it.
 */
test('resources resolve in the packaged layout, not just a dev checkout', () => {
  const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'ae-ext-'));
  try {
    fs.mkdirSync(path.join(ext, 'server'));
    // docs.js reads its resource list from the app profile, so both ship.
    for (const f of ['docs.js', 'app-profile.js']) {
      fs.copyFileSync(path.join(__dirname, '..', '..', 'cep', 'server', f), path.join(ext, 'server', f));
    }
    fs.mkdirSync(path.join(ext, 'docs', 'illustrator'), { recursive: true });
    for (const f of ['INSTALL.md', 'RECIPES.md', 'CAPABILITIES.md', 'INTEGRATIONS.md', 'illustrator/INSTALL.md', 'illustrator/RECIPES.md']) {
      fs.copyFileSync(path.join(__dirname, '..', '..', 'docs', f), path.join(ext, 'docs', f));
    }
    const packaged = require(path.join(ext, 'server', 'docs.js'));
    for (const r of packaged.RESOURCES) {
      const text = packaged.readResource(r.uri).contents[0].text;
      assert.doesNotMatch(text, /missing from this install/, `${r.uri} must resolve inside a packaged extension`);
    }
    // Every other app's docs resolve through the same packaged layout.
    const { PROFILES } = require(path.join(ext, 'server', 'app-profile.js'));
    for (const p of Object.values(PROFILES)) {
      for (const r of p.resources) {
        assert.ok(fs.existsSync(packaged.resolveDoc(r.file)), `${p.id} ${r.uri} must resolve inside a packaged extension`);
      }
    }
  } finally {
    fs.rmSync(ext, { recursive: true, force: true });
  }
});

test('every packager ships docs/ into the extension', () => {
  const root = path.join(__dirname, '..', '..');
  const checks = {
    'scripts/build-zxp.sh': /docs\/\*\.md[\s\S]*docs\/illustrator/,
    'scripts/build-dmg.sh': /docs\/\*\.md[\s\S]*docs\/illustrator/,
    'scripts/installer/windows-installer.iss': /docs\\\*\.md[\s\S]*docs\\illustrator/,
  };
  for (const [f, re] of Object.entries(checks)) {
    assert.match(fs.readFileSync(path.join(root, f), 'utf8'), re, `${f} must copy docs/*.md into the package`);
  }
});

test('resources/list is no longer an empty stub', async () => {
  const res = await rpc('resources/list');
  assert.ok(res.result.resources.length > 0, 'an agent with no repo checkout must be able to find the docs');
  for (const r of res.result.resources) {
    assert.ok(r.uri && r.name && r.description, 'each resource needs a description to be discoverable');
  }
});

test('initialize declares the resources capability', async () => {
  const res = await rpc('initialize', { protocolVersion: '2025-06-18' });
  assert.ok(res.result.capabilities.resources, 'clients skip resources entirely unless it is declared');
});

test('initialize points the agent at the recipes before it authors anything', async () => {
  const res = await rpc('initialize', { protocolVersion: '2025-06-18' });
  assert.match(res.result.instructions, /ae-vision:\/\/recipes/);
});

test('resources/read returns the capability matrix', async () => {
  const res = await rpc('resources/read', { uri: 'ae-vision://capabilities' });
  assert.match(res.result.contents[0].text, /\bpass\b/i);
  assert.match(res.result.contents[0].text, /\bfail\b/i);
});

test('resources/read rejects an unknown uri rather than returning nothing', async () => {
  const res = await rpc('resources/read', { uri: 'ae-vision://nope' });
  assert.ok(res.error, 'an unknown uri must be an error, not an empty document');
});

test('resources/read requires a uri', async () => {
  const res = await rpc('resources/read', {});
  assert.ok(res.error);
});

test('the recipes carry the traps that schemas cannot express', () => {
  const text = readResource('ae-vision://recipes').contents[0].text;
  // Each of these cost real debugging time; losing one from the doc is a regression.
  assert.match(text, /ignores the layer's own Scale/i);
  assert.match(text, /NO_VALUE/, 'shape gradients being unreachable must stay documented');
  assert.match(text, /ternary/i, 'the ExtendScript ternary hazard must stay documented');
  assert.match(text, /reloadHost/, 'the host does not hot-reload; that must be discoverable');
});

test('listResources does not leak absolute filesystem paths', () => {
  for (const r of listResources()) {
    assert.strictEqual(r.file, undefined);
  }
});

test('the integrations resource carries the adapter contract', () => {
  const text = readResource('ae-vision://integrations').contents[0].text;
  assert.match(text, /\/rpc/);
  assert.match(text, /\.ae-mcp-vision\/token/, 'adapters must be told where the token lives');
  assert.match(text, /forbidden_origin/, 'the no-Origin rule must be explicit, or an Electron renderer fails silently');
  assert.match(text, /interpretationOverrides/);
  assert.match(text, /frame 0/i, 'the MVP frame-mapping rule must stay documented');
  assert.match(text, /time-remapped|time-stretched/i);
  assert.match(text, /setPathKeys/);
  assert.match(text, /keysPath/);
  assert.match(text, /SAM UI/);
  assert.match(text, /in development/i, 'the SAM UI adapter is not shipped; the doc must not claim it is');
  assert.match(text, /media-inventory\.sample\.json/, 'the contract sample must be discoverable from the doc');
});

test('recipes and capabilities point at the integrations resource', () => {
  assert.match(readResource('ae-vision://recipes').contents[0].text, /ae-vision:\/\/integrations/);
  assert.match(readResource('ae-vision://capabilities').contents[0].text, /ae-vision:\/\/integrations/);
});

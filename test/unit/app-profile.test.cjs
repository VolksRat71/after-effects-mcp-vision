/*
 * One extension, several apps. Each app's copy must come up as that app -
 * its own port, token, tools and host - and After Effects must keep exactly
 * what it had before other apps were added, or every existing client config
 * breaks on upgrade.
 *
 * Each case runs in a child process because the profile is resolved once, at
 * module load, the way it is inside CEP.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');

function probe(app, script) {
  const env = { ...process.env, AE_MCP_TOKEN_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-profile-')),
                ILLUSTRATOR_MCP_TOKEN_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-profile-')),
                PREMIERE_MCP_TOKEN_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-profile-')),
                AME_MCP_TOKEN_DIR: fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-profile-')) };
  if (app) env.MCP_HOST_APP = app; else delete env.MCP_HOST_APP;
  return JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: ROOT, env }).toString());
}

const SNAPSHOT = `
  const S = ${JSON.stringify(path.join(ROOT, 'cep', 'server'))} + '/';
  const http = require(S + 'http-server.js');
  const { createMcpHandler } = require(S + 'mcp.js');
  const { currentProfile } = require(S + 'app-profile.js');
  const p = currentProfile();
  const { createToolRegistry } = require(S + p.tools.replace('./', ''));
  const reg = createToolRegistry(async () => ({ ok: true, result: {} }));
  createMcpHandler(reg)(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })).then((r) => {
    const { listResources } = require(S + 'docs.js');
    console.log(JSON.stringify({ id: p.id, port: http.DEFAULT_PORT, tokenDirName: require('path').basename(p.tokenDir),
      service: r.result.serverInfo.name, instructions: r.result.instructions,
      tools: reg.tools.map((t) => t.name), resources: listResources().map((x) => x.uri), hostJsx: p.hostJsx }));
  });`;

test('with no host app, the profile is After Effects - the suite that predates Illustrator runs unchanged', () => {
  const out = probe(null, SNAPSHOT);
  assert.strictEqual(out.id, 'AEFT');
});

test('After Effects keeps its port, token folder, service name, tools and resources', () => {
  const out = probe('AEFT', SNAPSHOT);
  assert.strictEqual(out.port, 8791);
  assert.strictEqual(out.tokenDirName, '.ae-mcp-vision');
  assert.strictEqual(out.service, 'ae-mcp-vision');
  assert.ok(out.tools.every((n) => n.startsWith('ae_')) && out.tools.length === 16);
  assert.deepStrictEqual(out.resources, ['ae-vision://capabilities', 'ae-vision://recipes', 'ae-vision://install']);
  assert.match(out.instructions, /ae_query/);
  assert.strictEqual(out.hostJsx, path.join('host', 'ae', 'host.jsx'));
});

test('Illustrator gets its own port, token folder, service name, tools and resources', () => {
  const out = probe('ILST', SNAPSHOT);
  assert.strictEqual(out.port, 8792);
  assert.strictEqual(out.tokenDirName, '.illustrator-mcp-vision');
  assert.strictEqual(out.service, 'illustrator-mcp-vision');
  assert.ok(out.tools.every((n) => n.startsWith('ai_')) && out.tools.length === 10);
  assert.deepStrictEqual(out.resources, ['illustrator-vision://recipes', 'illustrator-vision://install']);
  assert.match(out.instructions, /ai_query/);
  assert.strictEqual(out.hostJsx, path.join('host', 'ai', 'host.jsx'));
});

test('Premiere Pro gets its own port, token folder, service name, tools and resources', () => {
  const out = probe('PPRO', SNAPSHOT);
  assert.strictEqual(out.port, 8794);
  assert.strictEqual(out.tokenDirName, '.premiere-mcp-vision');
  assert.strictEqual(out.service, 'premiere-mcp-vision');
  assert.ok(out.tools.every((n) => n.startsWith('pr_')) && out.tools.length === 12);
  assert.deepStrictEqual(out.resources, ['premiere-vision://recipes', 'premiere-vision://install']);
  assert.match(out.instructions, /pr_query/);
  assert.strictEqual(out.hostJsx, path.join('host', 'pr', 'host.jsx'));
});

test('Media Encoder gets its own port, token folder, service name, tools and resources, and relays', () => {
  const out = probe('AME', SNAPSHOT);
  assert.strictEqual(out.port, 8795);
  assert.strictEqual(out.tokenDirName, '.ame-mcp-vision');
  assert.strictEqual(out.service, 'ame-mcp-vision');
  assert.ok(out.tools.every((n) => n.startsWith('ame_')) && out.tools.length === 5);
  assert.deepStrictEqual(out.resources, ['ame-vision://recipes', 'ame-vision://install']);
  assert.match(out.instructions, /ame_diagnostics/);
  assert.strictEqual(out.hostJsx, path.join('host', 'ame', 'ops.jsx'));
  const { PROFILES } = require('../../cep/server/app-profile.js');
  assert.deepStrictEqual(Object.values(PROFILES).filter((p) => p.relay).map((p) => p.id), ['AME'], 'only Media Encoder relays');
});

test('an unknown host app fails loudly rather than serving the wrong tools', () => {
  assert.throws(() => probe('PHXS', SNAPSHOT), /No MCP profile for host app PHXS/);
});

test('every profile\'s docs exist on disk', () => {
  const { PROFILES } = require('../../cep/server/app-profile.js');
  for (const p of Object.values(PROFILES)) {
    for (const r of p.resources) {
      assert.ok(fs.existsSync(path.join(ROOT, 'docs', r.file)), `${p.id} ${r.uri} -> docs/${r.file} is missing`);
    }
    assert.ok(fs.existsSync(path.join(ROOT, 'cep', p.hostJsx)), `${p.id} host ${p.hostJsx} is missing`);
  }
});

const SERVER_ONLY = new Set(['AME']);

test('the manifest gives each host its own ExtendScript entry point', () => {
  const xml = fs.readFileSync(path.join(ROOT, 'cep/CSXS/manifest.xml'), 'utf8');
  const { PROFILES } = require('../../cep/server/app-profile.js');
  for (const p of Object.values(PROFILES)) {
    const blocks = [...xml.matchAll(new RegExp(`<DispatchInfo Host="${p.id}">([\\s\\S]*?)</DispatchInfo>`, 'g'))];
    // Media Encoder is server-only on purpose: it has no Window > Extensions menu, so no panel can exist there.
    const want = SERVER_ONLY.has(p.id) ? 1 : 2;
    assert.strictEqual(blocks.length, want, `${p.id} needs ${want === 1 ? 'a server' : 'a server and a panel'} DispatchInfo`);
    for (const b of blocks) {
      assert.match(b[1], new RegExp(`<ScriptPath>\\./${p.hostJsx.replace(/\\/g, '/').replace(/\./g, '\\.')}</ScriptPath>`));
    }
    assert.match(xml, new RegExp(`<Host Name="${p.id}" Version=`), `${p.id} missing from HostList`);
  }
});

/*
 * Pin what each app actually serves, not just which profile it picked.
 *
 * Review on PR #10 showed the profile tests were too loose: pointing
 * http-server's token line at the After Effects folder for both apps still
 * passed the whole suite. These run the real modules in a child process per
 * app - the profile is fixed at module load, as it is inside CEP - and check
 * the resolved token file and the /health body itself.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const SERVER = path.join(__dirname, '..', '..', 'cep', 'server');

function run(app, script, extraEnv = {}) {
  const env = { ...process.env, MCP_HOST_APP: app, ...extraEnv };
  // The token-dir overrides are what tests normally set; remove them so the
  // real default path is what gets resolved. Nothing here writes a token.
  if (!('AE_MCP_TOKEN_DIR' in extraEnv)) delete env.AE_MCP_TOKEN_DIR;
  if (!('ILLUSTRATOR_MCP_TOKEN_DIR' in extraEnv)) delete env.ILLUSTRATOR_MCP_TOKEN_DIR;
  if (!('PREMIERE_MCP_TOKEN_DIR' in extraEnv)) delete env.PREMIERE_MCP_TOKEN_DIR;
  if (!('AME_MCP_TOKEN_DIR' in extraEnv)) delete env.AME_MCP_TOKEN_DIR;
  const out = execFileSync(process.execPath, ['-e', `const S = ${JSON.stringify(SERVER + path.sep)};\n${script}`], { env });
  return JSON.parse(out.toString());
}

const TOKEN = `console.log(JSON.stringify(require(S + 'http-server.js').TOKEN_FILE));`;

test('each app resolves its own real token file', () => {
  assert.strictEqual(run('AEFT', TOKEN), path.join(os.homedir(), '.ae-mcp-vision', 'token'));
  assert.strictEqual(run('ILST', TOKEN), path.join(os.homedir(), '.illustrator-mcp-vision', 'token'));
  assert.strictEqual(run('PPRO', TOKEN), path.join(os.homedir(), '.premiere-mcp-vision', 'token'));
  assert.strictEqual(run('AME', TOKEN), path.join(os.homedir(), '.ame-mcp-vision', 'token'));
});

const HEALTH = (pong) => `
  const { createServer } = require(S + 'http-server.js');
  const app = createServer(async () => ({ ok: true, result: ${JSON.stringify(pong)} }), { port: 0, onLog: () => {} });
  app.listen().then(async () => {
    const port = app.server.address().port;
    const res = await fetch('http://127.0.0.1:' + port + '/health', { headers: { Authorization: 'Bearer ' + app.token } });
    const body = await res.json();
    await app.close();
    console.log(JSON.stringify(body));
  });`;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-pin-'));

test('After Effects /health is the same body main returns', () => {
  const body = run('AEFT', HEALTH({ pong: true, aeVersion: '26.5x89', time: 1 }), { AE_MCP_TOKEN_DIR: tmp() });
  // Exactly main's top-level fields, in main's order.
  assert.deepStrictEqual(Object.keys(body), ['ok', 'service', 'bridge', 'nodeVersion', 'mcpSdkViable', 'host']);
  assert.strictEqual(body.service, 'ae-mcp-vision');
  assert.deepStrictEqual(body.host, { reachable: true, aeVersion: '26.5x89' },
    "AE's host block must not gain fields - existing clients read it as-is");
});

test('Illustrator /health names its own service and reports appVersion', () => {
  const body = run('ILST', HEALTH({ pong: true, appVersion: '30.8.1', time: 1 }), { ILLUSTRATOR_MCP_TOKEN_DIR: tmp() });
  assert.strictEqual(body.service, 'illustrator-mcp-vision');
  assert.deepStrictEqual(body.host, { reachable: true, appVersion: '30.8.1' });
});

test('Premiere /health names its own service and reports appVersion', () => {
  const body = run('PPRO', HEALTH({ pong: true, appVersion: '26.0.2', time: 1 }), { PREMIERE_MCP_TOKEN_DIR: tmp() });
  assert.strictEqual(body.service, 'premiere-mcp-vision');
  assert.deepStrictEqual(body.host, { reachable: true, appVersion: '26.0.2' });
});

test('inside CEP the host app decides, and MCP_HOST_APP cannot override it', () => {
  const pick = (cepEnv) => run('ILST', `
    global.window = { __adobe_cep__: { getHostEnvironment: () => ${JSON.stringify(cepEnv)} } };
    try { console.log(JSON.stringify(require(S + 'app-profile.js').currentProfile().id)); }
    catch (e) { console.log(JSON.stringify('THREW ' + e.message)); }`);
  assert.strictEqual(pick(JSON.stringify({ appName: 'AEFT' })), 'AEFT', 'a stray MCP_HOST_APP=ILST must not flip After Effects');
  assert.match(pick('not json'), /^THREW CEP is present but did not report a host app/,
    'an unreadable host must fail, not fall back to After Effects on 8791');
});

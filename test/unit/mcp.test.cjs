const test = require('node:test');
const assert = require('node:assert');
const { createMcpHandler, PROTOCOL_VERSIONS } = require('../../cep/server/mcp.js');

const registry = {
  tools: [{ name: 'ae_query', description: 'x', inputSchema: { type: 'object' } }],
  async callTool(name, args) {
    if (name === 'boom') throw new Error('handler exploded');
    return { content: [{ type: 'text', text: JSON.stringify({ name, args }) }] };
  },
};

const handle = createMcpHandler(registry);
const rpc = (method, params, id = 1) => handle(JSON.stringify({ jsonrpc: '2.0', id, method, params }));

test('initialize negotiates a protocol version and advertises tools', async () => {
  const res = await rpc('initialize', { protocolVersion: '2024-11-05' });
  assert.strictEqual(res.result.protocolVersion, '2024-11-05');
  assert.ok(res.result.capabilities.tools);
  assert.strictEqual(res.result.serverInfo.name, 'ae-mcp-vision');
  assert.match(res.result.instructions, /ae_query/);
});

test('initialize falls back to our newest version when asked for an unknown one', async () => {
  const res = await rpc('initialize', { protocolVersion: '1999-01-01' });
  assert.strictEqual(res.result.protocolVersion, PROTOCOL_VERSIONS[0]);
});

test('tools/list returns the registry', async () => {
  const res = await rpc('tools/list');
  assert.strictEqual(res.result.tools.length, 1);
});

test('tools/call forwards name and arguments', async () => {
  const res = await rpc('tools/call', { name: 'ae_query', arguments: { command: 'sessionInfo' } });
  const payload = JSON.parse(res.result.content[0].text);
  assert.strictEqual(payload.name, 'ae_query');
  assert.deepStrictEqual(payload.args, { command: 'sessionInfo' });
});

test('tools/call without a name is an invalid-params error', async () => {
  const res = await rpc('tools/call', {});
  assert.strictEqual(res.error.code, -32602);
});

test('a throwing tool becomes an internal error, not a crash', async () => {
  const res = await rpc('tools/call', { name: 'boom' });
  assert.strictEqual(res.error.code, -32603);
  assert.match(res.error.message, /exploded/);
});

test('unknown methods are method-not-found', async () => {
  const res = await rpc('does/notExist');
  assert.strictEqual(res.error.code, -32601);
});

test('notifications get no reply', async () => {
  assert.strictEqual(await handle(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })), null);
});

test('an unknown notification is still silent', async () => {
  assert.strictEqual(await handle(JSON.stringify({ jsonrpc: '2.0', method: 'whatever/happened' })), null);
});

test('malformed JSON is a parse error', async () => {
  const res = await handle('{not json');
  assert.strictEqual(res.error.code, -32700);
});

test('a non-JSON-RPC object is an invalid request', async () => {
  const res = await handle(JSON.stringify({ hello: 'world' }));
  assert.strictEqual(res.error.code, -32600);
});

test('batches answer requests and drop notifications', async () => {
  const res = await handle(JSON.stringify([
    { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    { jsonrpc: '2.0', method: 'notifications/initialized' },
    { jsonrpc: '2.0', id: 2, method: 'ping' },
  ]));
  assert.strictEqual(res.length, 2);
  assert.deepStrictEqual(res.map((r) => r.id), [1, 2]);
});

test('a batch of only notifications yields no response body', async () => {
  const res = await handle(JSON.stringify([{ jsonrpc: '2.0', method: 'notifications/initialized' }]));
  assert.strictEqual(res, null);
});

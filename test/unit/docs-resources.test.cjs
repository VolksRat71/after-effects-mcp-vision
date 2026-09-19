const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

const { listResources, readResource, RESOURCES } = require('../../cep/server/docs.js');
const { createMcpHandler } = require('../../cep/server/mcp.js');

const handler = createMcpHandler({ tools: [], callTool: async () => ({}) });
const rpc = (method, params) => handler(JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }));

test('every advertised resource actually exists on disk', () => {
  for (const r of RESOURCES) {
    assert.ok(fs.existsSync(r.file), `${r.uri} points at a missing file: ${r.file}`);
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

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { createToolRegistry, TOOLS } = require('../../cep/server/tools.js');

/*
 * ae_query media: the footage inventory external adapters (SAM UI's roto
 * handoff first) read over /rpc. The host side only runs inside After Effects,
 * so the integration suite covers behaviour; this covers the wiring, the
 * read-only guarantee and the contract sample adapters build against.
 */
const ROOT = path.join(__dirname, '..', '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const query = TOOLS.find((t) => t.name === 'ae_query');
const SAMPLE = JSON.parse(read('test/fixtures/media-inventory.sample.json'));

test('media is an ae_query command with an includeIneligible flag', () => {
  assert.ok(query.inputSchema.properties.command.enum.includes('media'));
  assert.strictEqual(query.inputSchema.properties.includeIneligible.type, 'boolean');
  assert.match(query.inputSchema.properties.includeIneligible.description, /^media:/);
});

test('the media description tells a model what it is for, what it returns and what it costs', () => {
  const d = query.description;
  assert.match(d, /- media:/);
  assert.match(d, /external/i, 'the purpose is external adapters, which a model would not guess');
  assert.match(d, /roto/i);
  for (const field of ['path', 'missing', 'frames', 'useProxy', 'conformFrameRate', 'interpretationOverrides']) {
    assert.ok(d.includes(field), `description should name ${field}`);
  }
  assert.match(d, /reconnect/i, 'missing items are kept, and why');
  assert.match(d, /tokens per item/i, 'token cost must be stated');
  assert.match(d, /Read-only/);
  assert.match(d, /ae-vision:\/\/integrations/);
});

test('ae_query media dispatches to the media host op with its arguments', async () => {
  const calls = [];
  const reg = createToolRegistry(async (op, args) => { calls.push({ op, args }); return { ok: true, result: SAMPLE.result }; });
  const res = await reg.callTool('ae_query', { command: 'media', includeIneligible: true });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].op, 'media');
  assert.strictEqual(calls[0].args.includeIneligible, true);
  assert.deepStrictEqual(JSON.parse(res.content[0].text), SAMPLE.result);
});

test('media is a query op and never opens an undo group', () => {
  const q = read('cep/host/ops-query.jsx');
  assert.match(q, /var __mcp_queryOps = \{[\s\S]*\n    media: function \(args\)/);
  const ops = read('cep/host/ops.jsx');
  const mutating = ops.slice(ops.indexOf('var __mcp_mutating'), ops.indexOf('function __mcp_wantsUndo'));
  assert.doesNotMatch(mutating, /\bmedia\b/, 'a read-only inventory must not be in __mcp_mutating');
});

test('the contract sample has the envelope, project identity and one of each item state', () => {
  assert.strictEqual(SAMPLE.ok, true);
  const r = SAMPLE.result;
  for (const k of ['path', 'name', 'dirty', 'numItems']) assert.ok(k in r.project, `project.${k}`);
  assert.ok(r.items.filter((i) => !i.missing).length >= 2, 'two present eligible items');
  assert.ok(r.items.some((i) => i.missing === true), 'one missing item');
  assert.ok(r.items.some((i) => i.interpretationOverrides.length > 0), 'one item an MVP adapter must refuse');
  assert.deepStrictEqual(r.counts, {
    footage: r.items.length + r.ineligible.length, eligible: r.items.length,
    missing: r.items.filter((i) => i.missing).length, ineligible: r.ineligible.length,
  });
  for (const i of r.ineligible) assert.ok(i.reason, `${i.name} carries a reason`);
});

test('the contract sample uses only placeholder paths', () => {
  const paths = [];
  JSON.stringify(SAMPLE, (k, v) => { if ((k === 'path' || k === 'proxyPath') && v) paths.push(v); return v; });
  assert.ok(paths.length >= 4);
  for (const p of paths) assert.match(p, /^\/Users\/example\//, `${p} must not be a real user path`);
});

test('every field in the contract sample is one the host actually emits', () => {
  // If the host stops writing a field, adapters built on the sample break
  // silently. Assert each key appears as an assignment in the host source.
  const src = read('cep/host/ops-query.jsx');
  const media = src.slice(src.indexOf('function __mcp_mediaRecord'));
  const emitted = (obj, key) => new RegExp(`\\b${obj}\\.${key}\\s*=|\\b${key}:\\s`).test(media);
  const r = SAMPLE.result;
  for (const k of Object.keys(r.project)) assert.ok(emitted('project', k), `project.${k}`);
  for (const k of Object.keys(r.counts)) assert.ok(new RegExp(`\\b${k}:`).test(media), `counts.${k}`);
  for (const item of r.items) {
    for (const k of Object.keys(item)) assert.ok(emitted('r', k), `item.${k}`);
    for (const k of Object.keys(item.interpretation)) assert.ok(emitted('interp', k), `interpretation.${k}`);
    for (const o of item.interpretationOverrides) assert.ok(media.includes(`o.push("${o}")`), `override ${o}`);
  }
  for (const item of r.ineligible) {
    for (const k of Object.keys(item)) assert.ok(emitted('r', k), `ineligible.${k}`);
    assert.ok(media.includes(`reason = "${item.reason}"`), `reason ${item.reason}`);
  }
});

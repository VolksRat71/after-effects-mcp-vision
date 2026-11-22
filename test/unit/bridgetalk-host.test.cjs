/*
 * The shared relay ops (cep/host/bridgetalk.jsx), run under node:vm with a fake
 * BridgeTalk, loaded the way the Premiere host loads them. The point of most
 * of these is what the ops REFUSE: they must stay a way to reach Media
 * Encoder and nothing else.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const HOST = path.join(__dirname, '..', '..', 'cep', 'host');

function load(sendResult = true) {
  const sent = [];
  class BridgeTalk {
    send() { sent.push(this); return sendResult; }
  }
  const ctx = { BridgeTalk };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(HOST, 'bridgetalk.jsx'), 'utf8'), ctx);
  const op = (name, args) => { try { return { ok: true, result: JSON.parse(JSON.stringify(ctx.__mcp_bridgeTalkOps[name](args))) }; } catch (e) { return { ok: false, code: e.code, message: e.message }; } };
  return { ctx, sent, op };
}

test('only the target ame is accepted', () => {
  const { sent, op } = load();
  for (const target of ['premiere', 'aftereffects', 'photoshop', undefined, 'AME']) {
    assert.strictEqual(op('bridgeTalkSend', { target, body: '1' }).code, 'bad_target', String(target));
  }
  assert.strictEqual(sent.length, 0);
  assert.strictEqual(op('bridgeTalkSend', { target: 'ame', body: '' }).code, 'bad_value');
});

test('send is async: it returns an id at once and the answer is read later, once', () => {
  const { sent, op } = load();
  const id = op('bridgeTalkSend', { target: 'ame', body: '1+1' }).result.id;
  assert.strictEqual(sent[0].target, 'ame');
  assert.strictEqual(sent[0].body, '1+1');
  assert.deepStrictEqual(op('bridgeTalkResult', { id }).result, { state: 'pending' });
  sent[0].onResult({ body: '2' });
  assert.deepStrictEqual(op('bridgeTalkResult', { id }).result, { state: 'done', body: '2' });
  assert.strictEqual(op('bridgeTalkResult', { id }).code, 'unknown_id', 'a result is removed when read');
});

test('onError is stored, and a stored timeout state is reported', () => {
  const { sent, op } = load();
  const a = op('bridgeTalkSend', { target: 'ame', body: 'x' }).result.id;
  sent[0].onError({ body: 'boom' });
  assert.deepStrictEqual(op('bridgeTalkResult', { id: a }).result, { state: 'error', body: 'boom' });
  const b = op('bridgeTalkSend', { target: 'ame', body: 'y', timeoutMs: 1 }).result.id;
  const t = Date.now(); while (Date.now() - t < 5) { /* let the 1 ms timeout pass */ }
  assert.strictEqual(op('bridgeTalkResult', { id: b }).result.state, 'timeout');
});

test('a send that BridgeTalk refuses is an error and leaves nothing behind', () => {
  const { ctx, op } = load(false);
  assert.strictEqual(op('bridgeTalkSend', { target: 'ame', body: 'x' }).code, 'send_failed');
  assert.strictEqual(Object.keys(ctx.__mcp_bt.results).length, 0);
});

test('results are capped, dropping the oldest', () => {
  const { ctx, op } = load();
  const ids = [];
  for (let i = 0; i < 60; i++) ids.push(op('bridgeTalkSend', { target: 'ame', body: String(i) }).result.id);
  assert.strictEqual(Object.keys(ctx.__mcp_bt.results).length, 50);
  assert.strictEqual(op('bridgeTalkResult', { id: ids[0] }).code, 'unknown_id');
  assert.strictEqual(op('bridgeTalkResult', { id: ids[59] }).result.state, 'pending');
});

test('both the Premiere and After Effects hosts include and register the ops', () => {
  for (const [dir, tableList] of [['pr', 'ops.jsx'], ['ae', 'ops.jsx']]) {
    assert.match(fs.readFileSync(path.join(HOST, dir, 'host.jsx'), 'utf8'), /#include "\.\.\/bridgetalk\.jsx"/, dir);
    assert.match(fs.readFileSync(path.join(HOST, dir, tableList), 'utf8'), /__mcp_bridgeTalkOps\]/, dir);
  }
});

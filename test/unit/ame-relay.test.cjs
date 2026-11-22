/*
 * The Media Encoder relay, against fake Premiere / After Effects bridges on
 * real local sockets. The fake bridge "delivers" the script by running it in a
 * vm against a tiny fake Media Encoder, so the body the relay builds (polyfill
 * + ops.jsx + one __ame_exec call) is proven to run, not just to be sent.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRelayCallHost, defaultRelays } = require('../../cep/server/ame-relay.js');

const fakeAme = () => ({
  buildNumber: '26.0.2.1',
  getEncoderHost: () => ({ getBatchEncoderStatus: () => 'stopped', isBatchRunning: () => false, getFormatList: () => 'H.264,QuickTime', addEventListener() {} }),
  getFrontend: () => ({ addEventListener() {} }),
  getExporter: () => ({ addEventListener() {} }),
});

function runBody(body) {
  const ctx = { app: fakeAme(), $: { global: {} } };
  // Media Encoder receives every backslash doubled (measured on 26.0.2); the fake does the same to every body.
  return vm.runInNewContext(body.replace(/\\/g, '\\\\'), ctx);
}

/** A fake bridge. opts: service, token, knowsSend, pendingPolls, resultState, resultBody */
async function fakeBridge(name, opts = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ame-relay-'));
  const tokenFile = path.join(dir, 'token');
  fs.writeFileSync(tokenFile, 'tok-' + name);
  const seen = { healths: 0, sends: 0, polls: 0, bodies: [], targets: [] };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      const reply = (o) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(o)); };
      if (req.headers.authorization !== 'Bearer tok-' + name) { res.statusCode = 401; return reply({ ok: false, error: { code: 'unauthorized' } }); }
      if (req.url === '/health') { seen.healths++; } if (req.url === '/health') return reply({ ok: true, service: opts.service || name });
      const { op, args } = JSON.parse(raw);
      if (op === 'bridgeTalkSend') {
        if (opts.knowsSend === false) return reply({ ok: false, error: { code: 'unknown_op', message: 'No such op: bridgeTalkSend' } });
        if (opts.dropSend) { seen.sends++; return req.socket.destroy(); }
        if (opts.sendError) return reply({ ok: false, error: opts.sendError });
        seen.sends++; seen.bodies.push(args.body); seen.targets.push(args.target);
        return reply({ ok: true, result: { id: 'id1' } });
      }
      if (op === 'bridgeTalkResult') {
        seen.polls++;
        if (seen.polls <= (opts.pendingPolls || 0)) return reply({ ok: true, result: { state: 'pending' } });
        const state = opts.resultState || 'done';
        const body = opts.resultBody !== undefined ? opts.resultBody : runBody(seen.bodies[seen.bodies.length - 1]);
        return reply({ ok: true, result: { state, body: state === 'timeout' ? undefined : body } });
      }
      reply({ ok: false, error: { code: 'unknown_op' } });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { name, port: server.address().port, service: name, tokenFile, seen, close: () => server.close() };
}

const relays = (...bs) => bs.map((b) => ({ name: b.name, port: b.port, service: b.service, tokenFile: b.tokenFile }));

test('it prefers Premiere, runs the sent script for real, and reports the relay', async () => {
  const pr = await fakeBridge('premiere'), ae = await fakeBridge('after-effects');
  try {
    const call = createRelayCallHost({ relays: relays(pr, ae), pollMs: 5 });
    const r = await call('info', {}, 5000);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    assert.strictEqual(r.result.buildNumber, '26.0.2.1');
    assert.deepStrictEqual(r.result.formats, ['H.264', 'QuickTime']);
    assert.strictEqual(call.lastRelay().name, 'premiere');
    assert.deepStrictEqual(pr.seen.targets, ['ame']);
    assert.strictEqual(ae.seen.sends, 0);
  } finally { pr.close(); ae.close(); }
});

test('it falls back to After Effects when Premiere is not there, or its host lacks bridgeTalkSend', async () => {
  const dead = await fakeBridge('premiere'); dead.close();
  const old = await fakeBridge('premiere-old', { knowsSend: false });
  const ae = await fakeBridge('after-effects');
  try {
    const call = createRelayCallHost({ relays: relays(dead, old, ae), pollMs: 5 });
    assert.strictEqual((await call('ping', {}, 5000)).ok, true);
    assert.strictEqual(call.lastRelay().name, 'after-effects');
    // and it remembers: the next call goes straight there
    const before = old.seen.sends;
    await call('ping', {}, 5000);
    assert.strictEqual(old.seen.sends, before);
  } finally { old.close(); ae.close(); }
});

test('a port that answers as the wrong service is not a relay', async () => {
  const imposter = await fakeBridge('premiere', { service: 'sam-ui' });
  try {
    const r = await createRelayCallHost({ relays: relays(imposter), pollMs: 5 })('ping', {}, 1000);
    assert.strictEqual(r.error.code, 'no_relay');
    assert.match(r.error.message, /sam-ui/);
    assert.strictEqual(imposter.seen.sends, 0, 'nothing may be sent to the wrong service');
  } finally { imposter.close(); }
});

test('it polls until the answer is done', async () => {
  const pr = await fakeBridge('premiere', { pendingPolls: 3 });
  try {
    const r = await createRelayCallHost({ relays: relays(pr), pollMs: 5 })('status', {}, 5000);
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.result.batchStatus, 'stopped');
    assert.strictEqual(pr.seen.polls, 4);
  } finally { pr.close(); }
});

test('ame_timeout when Media Encoder never answers, whether the host or the relay notices', async () => {
  const slow = await fakeBridge('premiere', { pendingPolls: 1e9 });
  const hostTimeout = await fakeBridge('premiere', { resultState: 'timeout' });
  try {
    assert.strictEqual((await createRelayCallHost({ relays: relays(slow), pollMs: 5 })('ping', {}, 100)).error.code, 'ame_timeout');
    assert.strictEqual((await createRelayCallHost({ relays: relays(hostTimeout), pollMs: 5 })('ping', {}, 5000)).error.code, 'ame_timeout');
  } finally { slow.close(); hostTimeout.close(); }
});

test('no_relay names what to do when neither bridge answers or both hosts are old', async () => {
  const a = await fakeBridge('premiere'); a.close();
  const b = await fakeBridge('after-effects', { knowsSend: false });
  try {
    const r = await createRelayCallHost({ relays: relays(a, b), pollMs: 5 })('ping', {}, 1000);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.error.code, 'no_relay');
    assert.match(r.error.message, /reloadHost/);
    assert.match(r.error.message, /lacks bridgeTalkSend/);
  } finally { b.close(); }
});

test('a send the host itself refuses is reported, not retried elsewhere; odd replies are named', async () => {
  const refuses = await fakeBridge('premiere', { sendError: { code: 'send_failed', message: 'is Media Encoder running?' } });
  const ae = await fakeBridge('after-effects');
  const junk = await fakeBridge('junk', { resultBody: 'EvalScript error.' });
  const err = await fakeBridge('err', { resultState: 'error', resultBody: 'boom' });
  try {
    const r = await createRelayCallHost({ relays: relays(refuses, ae), pollMs: 5 })('ping', {}, 1000);
    assert.strictEqual(r.error.code, 'send_failed');
    assert.strictEqual(ae.seen.sends, 0);
    assert.strictEqual((await createRelayCallHost({ relays: relays(junk), pollMs: 5 })('ping', {}, 1000)).error.code, 'ame_bad_reply');
    assert.strictEqual((await createRelayCallHost({ relays: relays(err), pollMs: 5 })('ping', {}, 1000)).error.code, 'ame_error');
  } finally { refuses.close(); ae.close(); junk.close(); err.close(); }
});

test('a relay with no token file is skipped', async () => {
  const pr = await fakeBridge('premiere');
  fs.unlinkSync(pr.tokenFile);
  try {
    const r = await createRelayCallHost({ relays: relays(pr), pollMs: 5 })('ping', {}, 1000);
    assert.strictEqual(r.error.code, 'no_relay');
    assert.match(r.error.message, /no token file/);
  } finally { pr.close(); }
});

test('the body survives BridgeTalk doubling every backslash, whatever the args hold', async () => {
  const pr = await fakeBridge('premiere');
  try {
    const call = createRelayCallHost({ relays: relays(pr), pollMs: 5 });
    const realRun = runBody;
    const r = await call('info', { path: 'C:\\a "b"\nc\u2028d' }, 5000);
    assert.strictEqual(r.ok, true, JSON.stringify(r));
    const sent = pr.seen.bodies[0];
    assert.ok(!sent.includes('\\'), 'no backslash left for BridgeTalk to double');
    const out = JSON.parse(realRun(sent));
    assert.strictEqual(out.ok, true);
  } finally { pr.close(); }
});

test('the default relays are Premiere and After Effects only; SAM UI\'s 8793 never gets a token', () => {
  assert.deepStrictEqual(defaultRelays().map((r) => r.name), ['premiere', 'after-effects']);
  assert.ok(!defaultRelays().some((r) => r.port === 8793));
});

test('a relay is health-checked once, then reused without probing', async () => {
  const pr = await fakeBridge('premiere');
  try {
    const call = createRelayCallHost({ relays: relays(pr), pollMs: 5 });
    await call('ping', {}, 2000); await call('ping', {}, 2000); await call('ping', {}, 2000);
    assert.strictEqual(pr.seen.healths, 1);
    assert.strictEqual(pr.seen.sends, 3);
  } finally { pr.close(); }
});

test('a send that fails after the health check passed is relay_lost and is NOT retried on the next relay', async () => {
  const pr = await fakeBridge('premiere', { dropSend: true });
  const ae = await fakeBridge('after-effects');
  try {
    const call = createRelayCallHost({ relays: relays(pr, ae), pollMs: 5 });
    const r = await call('queueFile', {}, 2000);
    assert.strictEqual(r.error.code, 'relay_lost');
    assert.strictEqual(ae.seen.sends, 0, 'the first relay may still deliver it, so the second must not');
    assert.strictEqual(call.lastRelay(), null);
  } finally { pr.close(); ae.close(); }
});

test('a remembered relay that has gone away (connection refused) falls through to the next', async () => {
  const pr = await fakeBridge('premiere'); const ae = await fakeBridge('after-effects');
  const call = createRelayCallHost({ relays: relays(pr, ae), pollMs: 5 });
  await call('ping', {}, 2000);
  pr.close(); await new Promise((r) => setTimeout(r, 20));
  try {
    assert.strictEqual((await call('ping', {}, 2000)).ok, true);
    assert.strictEqual(call.lastRelay().name, 'after-effects');
  } finally { ae.close(); }
});

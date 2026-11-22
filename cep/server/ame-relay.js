/*
 * callHost for Media Encoder.
 *
 * Media Encoder's CEP runs our server but gives it no ExtendScript, so a host
 * op cannot go through evalScript. It goes by relay instead: the op's script
 * (JSON polyfill + host/ame/ops.jsx + one __ame_exec call) is handed to the
 * Premiere or After Effects bridge, whose host sends it to Media Encoder
 * through BridgeTalk. The answer is polled for.
 *
 * Same contract as client/bridge.js callHost: { ok, result } or { ok:false, error }.
 * Node built-ins only.
 */

const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');
const { PROFILES } = require('./app-profile.js');

const HOST_DIR = path.join(__dirname, '..', 'host');

function tokenFileFor(profile) {
  return path.join(process.env[profile.tokenDirEnv] || profile.tokenDir, 'token');
}

// Premiere first, then After Effects. Never 8793: that port belongs to SAM UI, and Premiere's token must not be sent there.
function defaultRelays() {
  const pr = PROFILES.PPRO, ae = PROFILES.AEFT;
  return [
    { name: 'premiere', port: Number(process.env[pr.portEnv] || pr.port), service: pr.service, tokenFile: tokenFileFor(pr) },
    { name: 'after-effects', port: Number(process.env[ae.portEnv] || ae.port), service: ae.service, tokenFile: tokenFileFor(ae) },
  ];
}

function request(port, method, urlPath, token, body, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1', port, method, path: urlPath, timeout: timeoutMs,
      headers: { Authorization: `Bearer ${token}`, ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}) },
    }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => { try { resolve(JSON.parse(raw)); } catch (e) { reject(new Error(`bad reply from :${port}: ${raw.slice(0, 120)}`)); } });
    });
    req.on('timeout', () => req.destroy(new Error(`timed out talking to :${port}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * @param {{relays?: object[], pollMs?: number}} [opts] relays and pollMs are test seams.
 */
function createRelayCallHost(opts = {}) {
  const relays = opts.relays || defaultRelays();
  const pollMs = opts.pollMs || 100;
  let last = null;

  const script = (op, args) => {
    const read = (f) => fs.readFileSync(path.join(HOST_DIR, f), 'utf8');
    const program = `${read('json-polyfill.jsx')}\n${read('ame/ops.jsx')}\n__ame_exec(${JSON.stringify(JSON.stringify({ op, args }))});`;
    // BridgeTalk doubles every backslash on the way into Media Encoder (measured on 26.0.2), which breaks string
    // escapes and regexes; percent-encoding leaves none to double.
    return `eval(decodeURIComponent("${encodeURIComponent(program)}"))`;
  };

  /*
   * Returns the relay's message id. Throws { skip } when nothing was sent and the next relay should be tried
   * (no token, refused connection, wrong service, host without bridgeTalkSend). Any other failure AFTER the
   * health check passed throws { fail }: the relay may still deliver the message late, so trying the next one
   * could run a queue call twice.
   */
  async function send(relay, body, timeoutMs) {
    let token;
    try { token = fs.readFileSync(relay.tokenFile, 'utf8').trim(); } catch (e) { throw { skip: `${relay.name}: no token file` }; }
    // The service check happens before the token goes anywhere; once a relay has passed it, it is not re-probed.
    if (relay !== last) {
      let health;
      try { health = await request(relay.port, 'GET', '/health', token); } catch (e) { throw { skip: `${relay.name}: not answering on ${relay.port}` }; }
      if (!health || health.service !== relay.service) throw { skip: `${relay.name}: port ${relay.port} is ${health && health.service ? health.service : 'not ' + relay.service}` };
    }
    let res;
    try {
      res = await request(relay.port, 'POST', '/rpc', token, { op: 'bridgeTalkSend', args: { target: 'ame', body, timeoutMs } }, 10000);
    } catch (e) {
      if (relay === last) last = null;
      if (e && e.code === 'ECONNREFUSED') throw { skip: `${relay.name}: not answering on ${relay.port}` };
      throw { fail: { code: 'relay_lost', message: `${relay.name} did not confirm the send (${e.message}); it may still arrive, so it was not retried elsewhere` } };
    }
    if (res.ok) return { token, id: res.result.id };
    const e = res.error || {};
    if (e.code === 'unknown_op' || e.code === 'unauthorized' || e.code === 'evalscript_error') {
      throw { skip: `${relay.name}: its host lacks bridgeTalkSend (${e.code})` };
    }
    throw { fail: { code: e.code || 'relay_failed', message: e.message || 'relay refused the send' } };
  }

  async function callHost(op, args = {}, timeoutMs = 30000) {
    const body = script(op, args);
    const order = last ? [last, ...relays.filter((r) => r !== last)] : relays;
    const why = [];
    for (const relay of order) {
      let sent;
      try {
        sent = await send(relay, body, timeoutMs + 5000);
      } catch (e) {
        if (e && e.skip && relay === last) last = null;
        if (e && e.fail) return { ok: false, error: e.fail };
        why.push(e && e.skip ? e.skip : String(e));
        continue;
      }
      last = relay;
      const until = Date.now() + timeoutMs;
      for (;;) {
        let r;
        try {
          r = await request(relay.port, 'POST', '/rpc', sent.token, { op: 'bridgeTalkResult', args: { id: sent.id } }, 10000);
        } catch (e) { return { ok: false, error: { code: 'relay_lost', message: `${relay.name} stopped answering: ${e.message}` } }; }
        if (!r.ok) return { ok: false, error: r.error || { code: 'relay_failed', message: 'result poll failed' } };
        const state = r.result.state;
        if (state === 'done') {
          try { return JSON.parse(r.result.body); } catch (e) {
            return { ok: false, error: { code: 'ame_bad_reply', message: `Media Encoder answered with something that is not JSON: ${String(r.result.body).slice(0, 200)}` } };
          }
        }
        if (state === 'error') return { ok: false, error: { code: 'ame_error', message: String(r.result.body).slice(0, 300) } };
        if (state === 'timeout' || Date.now() >= until) {
          return { ok: false, error: { code: 'ame_timeout', message: `Media Encoder did not answer within ${timeoutMs}ms (via ${relay.name}). Is it running and past its start-up?` } };
        }
        await new Promise((resolve) => setTimeout(resolve, pollMs));
      }
    }
    last = null;
    return { ok: false, error: { code: 'no_relay', message:
      'No Premiere Pro or After Effects bridge could carry the call to Media Encoder (' + why.join('; ') + '). ' +
      'One of them must be open with a host that has bridgeTalkSend: reload their host (pr_diagnostics reloadHost) or restart the app.' } };
  }

  callHost.lastRelay = () => (last ? { name: last.name, port: last.port } : null);
  return callHost;
}

module.exports = { createRelayCallHost, defaultRelays };

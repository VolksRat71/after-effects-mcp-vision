/*
 * HTTP surface hosted inside the CEP panel's Node context.
 *
 * Deliberately built on Node builtins only. CEP 12 ships its own Node runtime
 * and we do not yet know whether it is new enough for @modelcontextprotocol/sdk,
 * so /health reports the runtime and this layer stays dependency-free until
 * that is confirmed. The MCP protocol layer sits on top of this, not inside it.
 *
 * Port is explicit and fixed, never auto-picked: two MCP servers on this machine
 * (the two Obsidian vaults) race for ports at launch and have silently swapped.
 */

const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const DEFAULT_PORT = 8791;

/*
 * Loopback binding alone is not access control. Any local process can reach
 * this port, and a web page can attack it via DNS rebinding or a simple-request
 * CSRF. Since every op here drives After Effects and touches the filesystem,
 * the port is authenticated:
 *
 *   - a per-launch bearer token, written 0600 for the local MCP client to read
 *   - Host must be exactly loopback:<port>, which defeats DNS rebinding
 *   - any request carrying an Origin is rejected outright; browsers cannot set
 *     Authorization cross-origin without a preflight, which we also reject
 */
const TOKEN_FILE = path.join(os.tmpdir(), 'ae-mcp-vision', 'token');

function issueToken() {
  const token = crypto.randomBytes(32).toString('hex');
  fs.mkdirSync(path.dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, token, { mode: 0o600 });
  // writeFileSync only applies mode on create; enforce it if the file existed.
  fs.chmodSync(TOKEN_FILE, 0o600);
  return token;
}

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req, limitBytes = 5 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * @param {(op:string,args:object)=>Promise<object>} callHost
 * @param {{port?:number, onLog?:(msg:string)=>void}} options
 */
function createServer(callHost, options = {}) {
  const port = options.port || DEFAULT_PORT;
  const log = options.onLog || (() => {});
  const introspect = options.introspect || (() => ({}));

  const token = options.token || issueToken();

  const server = http.createServer(async (req, res) => {
    // No CORS surface at all. Nothing in a browser should ever talk to this.
    res.setHeader('Access-Control-Allow-Origin', 'null');
    res.setHeader('X-Content-Type-Options', 'nosniff');

    // A present Origin means a browser is calling. Always refuse.
    if (req.headers.origin) {
      json(res, 403, { ok: false, error: { code: 'forbidden_origin', message: 'Cross-origin requests are not accepted' } });
      return;
    }

    // DNS rebinding sends a foreign hostname to a loopback IP. Pin the Host.
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
    if (!allowedHosts.includes(req.headers.host)) {
      json(res, 403, { ok: false, error: { code: 'forbidden_host', message: `Unexpected Host: ${req.headers.host}` } });
      return;
    }

    const supplied = String(req.headers.authorization || '').replace(/^Bearer /, '');
    if (!timingSafeEqual(supplied, token)) {
      json(res, 401, { ok: false, error: { code: 'unauthorized', message: `Missing or bad bearer token. Read it from ${TOKEN_FILE}` } });
      return;
    }

    if (req.method === 'GET' && req.url === '/health') {
      let host = { reachable: false };
      try {
        const pong = await callHost('ping', {}, 5000);
        host = pong.ok ? { reachable: true, aeVersion: pong.result.aeVersion } : { reachable: false, error: pong.error };
      } catch (err) {
        host = { reachable: false, error: String(err) };
      }
      json(res, 200, {
        ok: true,
        service: 'ae-mcp-vision',
        nodeVersion: process.version,
        mcpSdkViable: satisfiesNode18(process.version),
        host,
      });
      return;
    }

    // Read-only worker state, for the optional status panel. The panel runs in
    // its own CEF process and cannot see worker JS state any other way.
    if (req.method === 'GET' && req.url === '/state') {
      json(res, 200, { ok: true, nodeVersion: process.version, port, ...introspect() });
      return;
    }

    if (req.method === 'POST' && req.url === '/rpc') {
      let parsed;
      try {
        parsed = JSON.parse(await readBody(req));
      } catch (err) {
        json(res, 400, { ok: false, error: { code: 'bad_request', message: String(err) } });
        return;
      }
      if (!parsed || typeof parsed.op !== 'string') {
        json(res, 400, { ok: false, error: { code: 'bad_request', message: 'Expected { op, args }' } });
        return;
      }
      log(`rpc ${parsed.op}`);
      try {
        json(res, 200, await callHost(parsed.op, parsed.args || {}));
      } catch (err) {
        json(res, 500, { ok: false, error: { code: 'bridge_failed', message: String(err) } });
      }
      return;
    }

    json(res, 404, { ok: false, error: { code: 'not_found', message: `${req.method} ${req.url}` } });
  });

  return {
    server,
    port,
    token,
    tokenFile: TOKEN_FILE,
    listen() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        // Loopback only. This must never be reachable off-machine.
        server.listen(port, '127.0.0.1', () => resolve(port));
      });
    },
    close() {
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

function satisfiesNode18(version) {
  const major = parseInt(String(version).replace(/^v/, '').split('.')[0], 10);
  return Number.isFinite(major) && major >= 18;
}

module.exports = { createServer, DEFAULT_PORT, satisfiesNode18, TOKEN_FILE };

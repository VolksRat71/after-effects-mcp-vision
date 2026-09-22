// Must be set BEFORE requiring http-server, which resolves the token path at
// module load. Without this the suite writes to (and deletes) the real token.
process.env.AE_MCP_TOKEN_DIR = require('node:fs').mkdtempSync(
  require('node:path').join(require('node:os').tmpdir(), 'ae-mcp-test-'),
);

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const fs = require('node:fs');
const os = require('node:os');
const { createServer, rotateToken, loadOrCreateToken, TOKEN_FILE } = require('../../cep/server/http-server.js');

const stubHost = async (op) => ({ ok: true, result: { pong: true, aeVersion: 'stub', op } });

async function withServer(fn, options = {}) {
  // port 0 lets the OS choose, so parallel runs cannot collide.
  const app = createServer(stubHost, { port: 0, onLog: () => {}, ...options });
  // Go through app.listen(), not server.listen(). The real path persists the
  // token only after a successful bind; calling the raw listener skipped that
  // and the token tests passed locally only because an earlier real run had
  // left a file behind. CI's clean /tmp caught it.
  await app.listen();
  const port = app.server.address().port;
  try { await fn({ port, token: app.token, app }); } finally { await app.close(); }
}

function rawRequest(port, { host, token, method = 'POST', path = '/rpc', body = '{"op":"ping"}' }) {
  return new Promise((resolve) => {
    const headers = [`Host: ${host}`, 'Content-Type: application/json', `Content-Length: ${Buffer.byteLength(body)}`, 'Connection: close'];
    if (token) headers.push(`Authorization: Bearer ${token}`);
    const socket = net.connect(port, '127.0.0.1', () => socket.write(`${method} ${path} HTTP/1.1\r\n${headers.join('\r\n')}\r\n\r\n${body}`));
    let buf = '';
    socket.on('data', (d) => (buf += d));
    socket.on('end', () => resolve({ status: Number(buf.split(' ')[1]), body: buf.split('\r\n\r\n')[1] || '' }));
    socket.on('error', () => resolve({ status: 0, body: '' }));
  });
}

test('a request with no token is rejected', async () => {
  await withServer(async ({ port }) => {
    const r = await rawRequest(port, { host: `127.0.0.1:${port}` });
    assert.strictEqual(r.status, 401);
  });
});

test('a request with the wrong token is rejected', async () => {
  await withServer(async ({ port }) => {
    const r = await rawRequest(port, { host: `127.0.0.1:${port}`, token: 'deadbeef' });
    assert.strictEqual(r.status, 401);
  });
});

test('a valid token is accepted', async () => {
  await withServer(async ({ port, token }) => {
    const r = await rawRequest(port, { host: `127.0.0.1:${port}`, token });
    assert.strictEqual(r.status, 200);
    assert.match(r.body, /"ok":true/);
  });
});

test('a foreign Host header is rejected, which is what blocks DNS rebinding', async () => {
  await withServer(async ({ port, token }) => {
    const r = await rawRequest(port, { host: 'evil.test', token });
    assert.strictEqual(r.status, 403);
    assert.match(r.body, /forbidden_host/);
  });
});

test('localhost is accepted alongside 127.0.0.1', async () => {
  await withServer(async ({ port, token }) => {
    const r = await rawRequest(port, { host: `localhost:${port}`, token });
    assert.strictEqual(r.status, 200);
  });
});

test('any Origin header is refused, which blocks browser CSRF', async () => {
  await withServer(async ({ port, token }) => {
    const body = '{"op":"ping"}';
    const res = await new Promise((resolve) => {
      const socket = net.connect(port, '127.0.0.1', () =>
        socket.write(`POST /rpc HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nOrigin: https://evil.test\r\nAuthorization: Bearer ${token}\r\nContent-Length: ${body.length}\r\nConnection: close\r\n\r\n${body}`));
      let buf = '';
      socket.on('data', (d) => (buf += d));
      socket.on('end', () => resolve(buf));
    });
    assert.match(res, /403/);
    assert.match(res, /forbidden_origin/);
  });
});

test('the token file is written 0600', async () => {
  await withServer(async ({ app }) => {
    assert.strictEqual(fs.statSync(app.tokenFile).mode & 0o777, 0o600);
  });
});

test('an authenticated MCP request reaches the handler', async () => {
  const handler = async (raw) => ({ jsonrpc: '2.0', id: JSON.parse(raw).id, result: { saw: true } });
  await withServer(async ({ port, token }) => {
    const r = await rawRequest(port, {
      host: `127.0.0.1:${port}`, token, path: '/mcp',
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }),
    });
    assert.strictEqual(r.status, 200);
    assert.match(r.body, /"saw":true/);
  }, { mcpHandler: handler });
});

test('a notification through /mcp gets 202 and an empty body', async () => {
  const handler = async () => null;
  await withServer(async ({ port, token }) => {
    const r = await rawRequest(port, {
      host: `127.0.0.1:${port}`, token, path: '/mcp',
      body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    });
    assert.strictEqual(r.status, 202);
    assert.strictEqual(r.body.trim(), '');
  }, { mcpHandler: handler });
});

test('an unknown route is a 404', async () => {
  await withServer(async ({ port, token }) => {
    const r = await rawRequest(port, { host: `127.0.0.1:${port}`, token, path: '/nope' });
    assert.strictEqual(r.status, 404);
  });
});

test('the token persists across server restarts so client configs keep working', async () => {
  const first = loadOrCreateToken();
  const second = loadOrCreateToken();
  assert.strictEqual(first, second, 'a restart must not invalidate a pasted config');
  assert.match(first, /^[0-9a-f]{64}$/);
});

test('a malformed token file is replaced rather than trusted', () => {
  fs.mkdirSync(require('node:path').dirname(TOKEN_FILE), { recursive: true });
  fs.writeFileSync(TOKEN_FILE, 'not-a-real-token');
  const token = loadOrCreateToken();
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.strictEqual(fs.readFileSync(TOKEN_FILE, 'utf8').trim(), token);
});

test('rotation produces a new token and persists it', () => {
  const before = loadOrCreateToken();
  const after = rotateToken();
  assert.notStrictEqual(before, after);
  assert.strictEqual(fs.readFileSync(TOKEN_FILE, 'utf8').trim(), after);
});

test('the DEFAULT token location is the home directory, not a temp dir', () => {
  // This suite redirects AE_MCP_TOKEN_DIR, so the default has to be checked in
  // a clean child process. A temp-dir default would vanish on OS cleanup and
  // silently break every saved client config.
  const { execFileSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.AE_MCP_TOKEN_DIR;
  // The module path is passed as an argument rather than written inline, so a
  // require() inside a string is not mistaken for a real dependency.
  const modulePath = require('node:path').join(__dirname, '..', '..', 'cep', 'server', 'http-server.js');
  const out = execFileSync(
    process.execPath,
    ['-e', 'process.stdout.write(require(process.argv[1]).TOKEN_FILE)', modulePath],
    { env, encoding: 'utf8' },
  );
  assert.ok(out.startsWith(os.homedir()), `default token path was ${out}`);
  assert.match(out, /\.ae-mcp-vision/);
});

test('AE_MCP_TOKEN_DIR redirects the token, which is what keeps tests off real state', () => {
  assert.ok(process.env.AE_MCP_TOKEN_DIR);
  assert.ok(TOKEN_FILE.startsWith(process.env.AE_MCP_TOKEN_DIR));
});

test('a server that fails to bind does not clobber a working server\'s token', async () => {
  await withServer(async ({ app: first, port }) => {
    const firstToken = fs.readFileSync(first.tokenFile, 'utf8').trim();

    // A second server on the same port must fail to listen...
    const second = createServer(stubHost, { port, onLog: () => {} });
    await assert.rejects(() => new Promise((resolve, reject) => {
      second.server.once('error', reject);
      second.server.listen(port, '127.0.0.1', resolve);
    }));

    // ...and the persisted token must be untouched. Both servers now read the
    // same stored token rather than minting their own, so they agree.
    assert.strictEqual(fs.readFileSync(first.tokenFile, 'utf8').trim(), firstToken.trim());
    assert.strictEqual(second.token, firstToken.trim());
  });
});

test('port 0 means "let the OS choose" and is not coerced to the default', async () => {
  await withServer(async ({ port }) => {
    assert.notStrictEqual(port, 8791, 'port 0 must not fall through to DEFAULT_PORT');
    assert.ok(port > 0);
  });
});

test('an omitted port falls back to the default', () => {
  const app = createServer(stubHost, { onLog: () => {} });
  assert.strictEqual(app.port, 8791);
});

test('concurrent first-run token creation converges on one value', () => {
  // The panel and the headless server are separate processes that both start
  // with After Effects. A read-then-write race here made every request 401.
  fs.rmSync(require('node:path').dirname(TOKEN_FILE), { recursive: true, force: true });
  const results = [];
  for (let i = 0; i < 8; i++) results.push(loadOrCreateToken());
  const unique = new Set(results);
  assert.strictEqual(unique.size, 1, `expected one token, got ${unique.size}`);
  assert.strictEqual(fs.readFileSync(TOKEN_FILE, 'utf8').trim(), results[0]);
});

test('an existing token is never overwritten by a later starter', () => {
  const first = loadOrCreateToken();
  const second = loadOrCreateToken();
  assert.strictEqual(first, second);
  assert.strictEqual(fs.readFileSync(TOKEN_FILE, 'utf8').trim(), first);
});

test('auth follows the token file, not a value cached at startup', async () => {
  await withServer(async ({ port, app }) => {
    // Simulate the file being rewritten after the server booted - which is
    // exactly what happened on a real install and broke every request.
    const rotated = rotateToken();
    assert.notStrictEqual(rotated, app.token, 'precondition: the cached token is now stale');

    const withNew = await rawRequest(port, { host: `127.0.0.1:${port}`, token: rotated });
    assert.strictEqual(withNew.status, 200, 'the token currently in the file must work');

    const withStale = await rawRequest(port, { host: `127.0.0.1:${port}`, token: app.token });
    assert.strictEqual(withStale.status, 401, 'the superseded token must stop working');
  });
});

/*
 * The panel is a CEP page, so its fetch always carries an Origin. Rejecting
 * every Origin meant the status panel could never see its own server: it
 * showed "No server on port 8791", then tried to start a second one and failed
 * because the headless extension already held the port. Found on a clean
 * install of 2.0.0.
 */
test('a CEP panel origin reaches the server; a web origin is still refused', async () => {
  await withServer(async ({ port, token }) => {
    const call = (origin) =>
      fetch(`http://127.0.0.1:${port}/health`, {
        headers: { Authorization: `Bearer ${token}`, Origin: origin },
      });

    for (const ok of ['null', 'file://', 'file:///Users/x/panel.html']) {
      const res = await call(ok);
      assert.strictEqual(res.status, 200, `panel origin ${ok} must reach its own server`);
    }

    for (const bad of ['https://evil.example', 'http://localhost:3000', 'http://127.0.0.1:8791']) {
      const res = await call(bad);
      assert.strictEqual(res.status, 403, `web origin ${bad} must stay refused`);
    }
  });
});

const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const fs = require('node:fs');
const { createServer } = require('../../cep/server/http-server.js');

const stubHost = async (op) => ({ ok: true, result: { pong: true, aeVersion: 'stub', op } });

async function withServer(fn, options = {}) {
  const app = createServer(stubHost, { port: 0, onLog: () => {}, ...options });
  // port 0 lets the OS choose, so parallel test runs cannot collide.
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(0, '127.0.0.1', resolve);
  });
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

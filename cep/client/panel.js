/*
 * Status panel. Deliberately NOT the owner of the server - the headless
 * .server extension owns it, so closing this panel kills nothing.
 *
 * If the headless extension did not start (StartOn is the least proven part of
 * this design on AE), the panel falls back to starting the server itself so the
 * bundle still works.
 *
 * Note: each CEP extension runs in its OWN CEF process, so the panel and the
 * headless server cannot share JS state directly. Everything the panel knows
 * about the server it learns over loopback HTTP - hence probeHealth rather than
 * importing the server's state.
 */

const { callHost } = require('./bridge.js');
const { startServer, PORT, TOKEN_FILE } = require('./start-server.js');
const fs = require('fs');

let owned = null;

function $(id) { return document.getElementById(id); }

function log(msg, isError) {
  const el = $('log');
  if (!el) return;
  const line = document.createElement('div');
  if (isError) line.className = 'err';
  line.textContent = `${new Date().toLocaleTimeString()}  ${msg}`;
  el.insertBefore(line, el.firstChild);
}

function setStatus(state, text) {
  $('dot').className = `dot ${state}`;
  $('status').textContent = text;
}

function readToken() {
  try { return fs.readFileSync(TOKEN_FILE, 'utf8').trim(); } catch (err) { return null; }
}

function showConfig(port) {
  const token = readToken();
  $('config').textContent = JSON.stringify(
    {
      mcpServers: {
        'ae-vision': {
          type: 'http',
          url: `http://127.0.0.1:${port}/mcp`,
          // Per-launch token. Regenerated every time the server starts.
          headers: { Authorization: `Bearer ${token || '<token unavailable>'}` },
        },
      },
    },
    null, 2
  );
}

async function probeHealth(port) {
  try {
    const token = readToken();
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    });
    return res.ok ? await res.json() : null;
  } catch (err) {
    return null;
  }
}

async function refresh() {
  const health = await probeHealth(PORT);

  if (health) {
    setStatus('up', `listening on 127.0.0.1:${PORT}${owned ? ' (panel-owned)' : ''}`);
    $('node').textContent = `${health.nodeVersion}${health.mcpSdkViable ? '' : '  — too old for MCP SDK'}`;
    $('ae').textContent = health.host.reachable
      ? `connected — ${health.host.aeVersion}`
      : `unreachable — ${health.host.error && health.host.error.code}`;
    showConfig(PORT);
    return;
  }

  setStatus('down', `nothing listening on ${PORT}`);
  $('ae').textContent = '—';
  $('config').textContent = `No server on port ${PORT}. Press Re-check to start one here.`;
}

async function boot() {
  $('node').textContent = process.version;
  log(`panel loaded, node ${process.version}`);

  // Give the headless extension a moment to claim the port first.
  await new Promise((r) => setTimeout(r, 400));

  let health = await probeHealth(PORT);
  if (!health) {
    log('no headless server found — starting one from the panel');
    const result = await startServer((m) => log(m));
    owned = result.app;
    if (result.state === 'failed') log('panel could not start a server either', true);
  } else {
    log('headless server already running');
  }

  // A direct host ping proves ExtendScript answers, independent of the HTTP layer.
  const pong = await callHost('ping', {}, 5000);
  log(pong.ok ? `host ping ok — ${pong.result.aeVersion}` : `host ping failed: ${pong.error.message}`, !pong.ok);

  $('recheck').addEventListener('click', async () => {
    if (!(await probeHealth(PORT))) {
      const result = await startServer((m) => log(m));
      owned = result.app;
    }
    await refresh();
  });

  await refresh();

  // Only tear down a server this panel actually owns.
  window.addEventListener('beforeunload', () => { if (owned) owned.close(); });
}

module.exports = { boot };

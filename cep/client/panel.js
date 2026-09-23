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

/*
 * Client configs, one per way a client can reach this server. Each was
 * verified against the real client, because the earlier versions were not:
 *
 * - Claude Desktop's config file only launches stdio servers, so pasting the
 *   HTTP block did nothing. It needs the mcp-remote bridge.
 * - Codex's bearer_token_env_var only works when Codex inherits the variable
 *   from a shell. The IDE extension and the ChatGPT desktop app share the same
 *   config.toml but are not launched from a shell, so they sent no token and
 *   got 401 - while `codex mcp list` still showed the server as healthy. A
 *   static http_headers entry works in all three.
 *
 * The token persists across After Effects restarts, so anything pasted from
 * here keeps working.
 */
function clientConfigs(port, token) {
  const url = `http://127.0.0.1:${port}/mcp`;
  const t = token || '<open After Effects to generate a token>';

  // The token rides in env, not args: Claude Desktop on Windows (and some other
  // clients) mangle spaces inside arguments.
  const bridge = JSON.stringify(
    { mcpServers: { 'ae-vision': {
      command: 'npx',
      args: ['-y', 'mcp-remote', url, '--header', 'Authorization:${AUTH_HEADER}', '--transport', 'http-only'],
      env: { AUTH_HEADER: `Bearer ${t}` },
    } } },
    null, 2
  );

  return {
    'Claude Code': {
      hint: 'Run in a terminal. --scope user adds it to every project.',
      body:
        `claude mcp add --transport http --scope user ae-vision ${url} \\\n` +
        `  --header "Authorization: Bearer ${t}"`,
    },
    'Claude Desktop': {
      hint: 'Settings > Developer > Edit Config, merge this in, then quit and reopen Claude Desktop. Needs Node.js 18+.',
      body: bridge,
    },
    'Codex / ChatGPT': {
      hint: 'Add to ~/.codex/config.toml. Shared by the Codex CLI, the IDE extension and the ChatGPT desktop app.',
      body:
        `[mcp_servers.ae_vision]\n` +
        `url = "${url}"\n` +
        `http_headers = { Authorization = "Bearer ${t}" }\n` +
        `# optional - run tools without asking (needed for codex exec):\n` +
        `# default_tools_approval_mode = "approve"`,
    },
    'Other clients': {
      hint: 'Use whichever your client supports. A client with a JSON mcpServers file can usually take the Claude Desktop block.',
      body:
        `Streamable HTTP\n` +
        `  URL:     ${url}\n` +
        `  Header:  Authorization: Bearer ${t}\n\n` +
        `stdio only (bridge)\n` +
        `  command: npx\n` +
        `  args:    -y mcp-remote ${url} --header Authorization:\${AUTH_HEADER} --transport http-only\n` +
        `  env:     AUTH_HEADER=Bearer ${t}`,
    },
  };
}

let activeClient = 'Claude Code';

function showConfig(port) {
  const configs = clientConfigs(port, readToken());
  const tabs = $('tabs');
  if (tabs && !tabs.childElementCount) {
    Object.keys(configs).forEach((name) => {
      const b = document.createElement('button');
      b.textContent = name;
      b.className = name === activeClient ? 'tab on' : 'tab';
      b.addEventListener('click', () => {
        activeClient = name;
        Array.from(tabs.children).forEach((c) => { c.className = c.textContent === name ? 'tab on' : 'tab'; });
        showConfig(port);
      });
      tabs.appendChild(b);
    });
  }
  const chosen = configs[activeClient];
  $('hint').textContent = chosen.hint;
  $('config').textContent = chosen.body;
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

  $('copy').addEventListener('click', () => {
    const text = $('config').textContent;
    // CEP's Chromium has the async clipboard API behind a permission the panel
    // does not have, so fall back to the old selection-based copy.
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      document.body.removeChild(ta);
      log(`copied ${activeClient} config`);
    } catch (err) {
      log(`copy failed: ${err}`, true);
    }
  });

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

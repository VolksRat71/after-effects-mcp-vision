/*
 * Shared server startup, used by both the headless extension and (as a
 * fallback) the visible panel. Exactly one of them should win the port; the
 * loser detects EADDRINUSE and reports "already running" rather than erroring.
 */

const { callHost } = require('./bridge.js');
const { createServer, DEFAULT_PORT, TOKEN_FILE } = require('../server/http-server.js');
const { createMcpHandler } = require('../server/mcp.js');
const { currentProfile } = require('../server/app-profile.js');

const PROFILE = currentProfile();
// Media Encoder has no ExtendScript of its own: its calls go by relay through Premiere or After Effects.
const hostCall = PROFILE.relay ? require('../server/ame-relay.js').createRelayCallHost() : callHost;
// Each app has its own tool surface; the transport underneath is shared.
const { createToolRegistry } = require(require('path').join(__dirname, '..', 'server', PROFILE.tools));

const PORT = Number(process.env[PROFILE.portEnv] || DEFAULT_PORT);

async function startServer(onLog = () => {}) {
  const registry = createToolRegistry(hostCall);
  const app = createServer(hostCall, {
    port: PORT,
    onLog,
    mcpHandler: createMcpHandler(registry),
  });
  try {
    await app.listen();
    onLog(`http server bound to 127.0.0.1:${app.port}`);
    onLog(`bearer token written to ${app.tokenFile}`);
    return { state: 'listening', port: app.port, token: app.token, app };
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') {
      // The headless extension almost certainly got there first. Not an error.
      onLog(`port ${PORT} already held - assuming the headless server owns it`);
      return { state: 'already-running', port: PORT, token: null, app: null };
    }
    onLog(`listen failed: ${err}`);
    return { state: 'failed', port: PORT, error: err, app: null };
  }
}

module.exports = { startServer, PORT, TOKEN_FILE };

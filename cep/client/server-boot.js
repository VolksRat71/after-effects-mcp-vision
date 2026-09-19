/*
 * Headless entry point. No DOM, no UI - just bring the server up and keep a
 * heartbeat in the CEP log so a dead extension is distinguishable from a
 * silent one.
 */

const { startServer } = require('./start-server.js');

async function boot() {
  const log = (m) => console.log(`[ae-mcp] ${m}`);
  log(`headless server starting, node ${process.version}`);

  const result = await startServer(log);
  log(`startup result: ${result.state} on port ${result.port}`);

  if (result.state === 'failed') {
    // Surfaced rather than swallowed: without this the extension just looks dead.
    console.error('[ae-mcp] server did not start', result.error);
  }
}

module.exports = { boot };

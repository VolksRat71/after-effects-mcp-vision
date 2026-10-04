/*
 * Which Adobe app this copy of the extension is running inside, and
 * everything that differs because of it.
 *
 * One extension is listed for several hosts in the manifest. Each app loads
 * its own copy, in its own process, so each gets its own server - its own
 * port, token, tool surface and ExtendScript host. Nothing is shared at run
 * time; this module is the single place that decides which is which.
 *
 * After Effects keeps exactly what it had before other apps were added: port
 * 8791, ~/.ae-mcp-vision/token, the ae-mcp-vision service name and the
 * ae-vision:// resources. Existing client configs keep working.
 *
 * Inside CEP the app comes from CEP's host environment and nothing else. Outside
 * CEP (unit tests, plain Node) there is none, so MCP_HOST_APP picks one and
 * After Effects is the default - the suite that predates the other apps runs
 * unchanged.
 */

const os = require('os');
const path = require('path');

const PROFILES = {
  AEFT: {
    id: 'AEFT',
    appName: 'After Effects',
    service: 'ae-mcp-vision',
    clientName: 'ae-vision',
    port: 8791,
    portEnv: 'AE_MCP_PORT',
    tokenDir: path.join(os.homedir(), '.ae-mcp-vision'),
    tokenDirEnv: 'AE_MCP_TOKEN_DIR',
    hostJsx: path.join('host', 'ae', 'host.jsx'),
    tools: './tools.js',
    instructions:
      'Drives a live After Effects session. Start with ae_query ' +
      "{command:'sessionInfo'} to see what is open, then " +
      "ae_query {command:'tree'} and {command:'propertyKeys'} to find things. " +
      'Address everything by the stable ids those return, never by index. ' +
      'Use ae_capture to look at what you actually built rather than ' +
      'inferring it from the object tree. ' +
      'Before authoring anything, read the resource ae-vision://recipes - it carries the ' +
      'create-then-style chain and the measurement traps that silently produce wrong ' +
      'layouts. ae-vision://capabilities says what is known to work and what cannot.',
    resources: [
      {
        uri: 'ae-vision://capabilities',
        name: 'Capability matrix',
        description:
          'Every probed After Effects technique with a pass / fail / needs-human-review verdict, ' +
          'measured against a live AE build rather than read off the API docs. Read this before ' +
          'telling a user something is impossible - and before assuming something is possible.',
        mimeType: 'text/markdown',
        file: 'CAPABILITIES.md',
      },
      {
        uri: 'ae-vision://recipes',
        name: 'Authoring recipes and gotchas',
        description:
          'How to actually build something: the create-then-style chain, the accepted value shapes ' +
          'for ae_set, and the measurement traps that silently produce wrong layouts.',
        mimeType: 'text/markdown',
        file: 'RECIPES.md',
      },
      {
        uri: 'ae-vision://integrations',
        name: 'External adapter contract',
        description:
          'For programs that drive this bridge directly (a roto/segmentation app, a render tool): the /rpc ' +
          'endpoint, the bearer token and why browser origins are refused, the media inventory, the rule ' +
          'that only unmodified full-source footage round-trips, and the ops that write masks back. Also ' +
          'when to recommend SAM UI for rotoscoping instead of masking frame by frame.',
        mimeType: 'text/markdown',
        file: 'INTEGRATIONS.md',
      },
      {
        uri: 'ae-vision://install',
        name: 'Install and troubleshooting',
        description: 'Installation, the signing/Gatekeeper situation, and what to do when the panel will not connect.',
        mimeType: 'text/markdown',
        file: 'INSTALL.md',
      },
    ],
  },
  ILST: {
    id: 'ILST',
    appName: 'Illustrator',
    service: 'illustrator-mcp-vision',
    clientName: 'illustrator-vision',
    port: 8792,
    portEnv: 'ILLUSTRATOR_MCP_PORT',
    tokenDir: path.join(os.homedir(), '.illustrator-mcp-vision'),
    tokenDirEnv: 'ILLUSTRATOR_MCP_TOKEN_DIR',
    hostJsx: path.join('host', 'ai', 'host.jsx'),
    tools: './tools-illustrator.js',
    instructions:
      'Drives a live Adobe Illustrator session. Start with ai_query ' +
      "{command:'sessionInfo'} to see which documents and artboards are open, then " +
      "ai_query {command:'tree'} to find items. Address every item by the uuid those " +
      'return, never by index or name. Coordinates are points, measured from the ' +
      "artboard's top-left corner with y growing DOWN - the same as the Illustrator " +
      'rulers, not the upside-down scripting default. ' +
      'Use ai_capture to look at what you actually built rather than inferring it ' +
      'from the object tree. Before authoring anything, read the resource ' +
      'illustrator-vision://recipes.',
    resources: [
      {
        uri: 'illustrator-vision://recipes',
        name: 'Authoring recipes and gotchas',
        description:
          'How to actually build something in Illustrator through this server: the coordinate convention, ' +
          'colour forms, text behaviour, and the traps measured against a live Illustrator build.',
        mimeType: 'text/markdown',
        file: 'illustrator/RECIPES.md',
      },
      {
        uri: 'illustrator-vision://install',
        name: 'Install and troubleshooting',
        description: 'Installing for Illustrator, connecting a client, and what to do when the server does not answer.',
        mimeType: 'text/markdown',
        file: 'illustrator/INSTALL.md',
      },
    ],
  },
};

function detectAppId() {
  const cep = typeof window !== 'undefined' && window.__adobe_cep__;
  // Inside CEP the real host decides, always. An environment variable must not
  // override it - a stray export or launchctl setenv would bring After Effects
  // up with Illustrator's tools - and an unreadable host must fail loudly, not
  // fall back to After Effects and take port 8791 inside Illustrator.
  if (cep) {
    let env = null;
    try { env = JSON.parse(cep.getHostEnvironment()); } catch (e) { env = null; }
    if (!env || !env.appName) {
      throw new Error('CEP is present but did not report a host app; refusing to guess which app this is');
    }
    return env.appName;
  }
  // Outside CEP (unit tests, plain Node): MCP_HOST_APP picks, default After Effects.
  return process.env.MCP_HOST_APP || 'AEFT';
}

function currentProfile() {
  const id = detectAppId();
  const p = PROFILES[id];
  if (!p) throw new Error(`No MCP profile for host app ${id}. Known: ${Object.keys(PROFILES).join(', ')}`);
  return p;
}

module.exports = { PROFILES, currentProfile, detectAppId };

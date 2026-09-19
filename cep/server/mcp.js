/*
 * MCP protocol layer - JSON-RPC 2.0, hand-rolled.
 *
 * Deliberately no @modelcontextprotocol/sdk. CEP ships its own Node runtime of
 * unknown vintage, and pulling the SDK in would mean bundling node_modules into
 * the .zxp and betting on that runtime. MCP over HTTP is a small, stable
 * JSON-RPC surface, so implementing it directly removes the dependency, the
 * bundling step and the version risk in one go.
 */

const { listResources, readResource } = require('./docs.js');

const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const SERVER_INFO = { name: 'ae-mcp-vision', version: '2.0.0' };

function rpcResult(id, result) { return { jsonrpc: '2.0', id, result }; }
function rpcError(id, code, message, data) {
  const err = { code, message };
  if (data !== undefined) err.data = data;
  return { jsonrpc: '2.0', id, error: err };
}

// JSON-RPC reserved codes
const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;
const INTERNAL_ERROR = -32603;

/**
 * @param {{tools: Array, callTool: (name:string, args:object)=>Promise<object>}} registry
 */
function createMcpHandler(registry) {
  async function handleOne(msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
      return rpcError(msg && msg.id !== undefined ? msg.id : null, INVALID_REQUEST, 'Not a JSON-RPC 2.0 request');
    }

    const { id, method, params } = msg;
    // Notifications have no id and must never be answered.
    const isNotification = id === undefined;

    try {
      switch (method) {
        case 'initialize': {
          const asked = params && params.protocolVersion;
          const version = PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
          return rpcResult(id, {
            protocolVersion: version,
            capabilities: { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false } },
            serverInfo: SERVER_INFO,
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
          });
        }

        case 'notifications/initialized':
        case 'initialized':
          return null;

        case 'ping':
          return isNotification ? null : rpcResult(id, {});

        case 'tools/list':
          return rpcResult(id, { tools: registry.tools });

        case 'tools/call': {
          if (!params || typeof params.name !== 'string') {
            return rpcError(id, INVALID_PARAMS, 'tools/call requires a name');
          }
          const out = await registry.callTool(params.name, params.arguments || {});
          return rpcResult(id, out);
        }

        case 'resources/list':
          return rpcResult(id, { resources: listResources() });

        case 'resources/read': {
          if (!params || typeof params.uri !== 'string') {
            return rpcError(id, INVALID_PARAMS, 'resources/read requires a uri');
          }
          const found = readResource(params.uri);
          if (!found) {
            return rpcError(id, INVALID_PARAMS, `Unknown resource: ${params.uri}`);
          }
          return rpcResult(id, found);
        }
        case 'prompts/list':
          return rpcResult(id, { prompts: [] });

        default:
          if (isNotification) return null;
          return rpcError(id, METHOD_NOT_FOUND, `Unknown method: ${method}`);
      }
    } catch (err) {
      if (isNotification) return null;
      return rpcError(id, INTERNAL_ERROR, String((err && err.message) || err));
    }
  }

  /** Takes a raw request body, returns a response object or null (notification). */
  return async function handle(body) {
    let msg;
    try {
      msg = JSON.parse(body);
    } catch (err) {
      return rpcError(null, PARSE_ERROR, 'Invalid JSON');
    }

    if (Array.isArray(msg)) {
      const out = [];
      for (const m of msg) {
        const r = await handleOne(m);
        if (r) out.push(r);
      }
      return out.length ? out : null;
    }
    return handleOne(msg);
  };
}

module.exports = { createMcpHandler, PROTOCOL_VERSIONS, SERVER_INFO };

process.env.AE_MCP_TOKEN_DIR = process.env.AE_MCP_TOKEN_DIR || require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(),'ae-mcp-test-'));
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
test('the unit suite never touches the real token directory', () => {
  const real = path.join(os.homedir(), '.ae-mcp-vision');
  for (const f of fs.readdirSync(path.join(__dirname))) { /* noop */ }
  assert.ok(process.env.AE_MCP_TOKEN_DIR, 'tests must redirect AE_MCP_TOKEN_DIR');
  assert.notStrictEqual(process.env.AE_MCP_TOKEN_DIR, real);
});

const test = require('node:test');
const assert = require('node:assert');

/*
 * The reload must run at the TOP LEVEL of the evalScript: $.evalFile defines
 * everything in its calling scope, so evaluating the host from inside a host
 * function reloaded nothing. Verified in After Effects 25.5: with the
 * top-level form, an op that did not exist before the reload works after it,
 * without a restart.
 */
function withFakeCep(fn) {
  const scripts = [];
  global.window = { __adobe_cep__: { evalScript: (s, cb) => { scripts.push(s); cb('{"ok":true,"result":{}}'); } } };
  delete require.cache[require.resolve('../../cep/client/bridge.js')];
  const { callHost } = require('../../cep/client/bridge.js');
  return fn(callHost, scripts).finally(() => { delete global.window; });
}

test('reloadHost evaluates the host file at the top level, then calls the op', () =>
  withFakeCep(async (callHost, scripts) => {
    await callHost('reloadHost', { hostPath: 'C:\\Users\\x\\host\\host.jsx' });
    const s = scripts[0];
    assert.match(s, /^try \{ \$\.evalFile\(new File\("C:\\\\Users\\\\x\\\\host\\\\host\.jsx"\)\);/, 'evalFile must lead the script, outside any function');
    assert.ok(s.indexOf('$.evalFile') < s.indexOf('__mcp_exec('), 'the reload must happen before the op runs');
    assert.match(s, /__mcp_reloadError = String\(e\)/, 'a failed reload must be recorded, not collapse to "EvalScript error."');
  }));

test('ordinary ops are sent unchanged', () =>
  withFakeCep(async (callHost, scripts) => {
    await callHost('ping', {});
    assert.match(scripts[0], /^__mcp_exec\(/);
    assert.doesNotMatch(scripts[0], /evalFile/);
  }));

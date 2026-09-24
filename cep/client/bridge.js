/*
 * Bridge from the CEP panel (Node/CEF context) into ExtendScript.
 *
 * evalScript is the only genuine bidirectional channel AE offers: it returns a
 * string. (AppleScript DoScript was measured returning app.exitCode - a single
 * integer - so it cannot carry structured data.)
 *
 * Its failure mode is that ANY error collapses to the literal string
 * "EvalScript error." with nothing else, so the host side serializes its own
 * errors and we treat that literal as a transport fault.
 */

const EVAL_ERROR = 'EvalScript error.';

function rawEval(script) {
  return new Promise((resolve, reject) => {
    const cep = window.__adobe_cep__;
    if (!cep || typeof cep.evalScript !== 'function') {
      reject(new Error('Not running inside a CEP host - __adobe_cep__ unavailable'));
      return;
    }
    try {
      cep.evalScript(script, (result) => resolve(result));
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Call a host op. Always resolves to { ok, result } or { ok:false, error }.
 * @param {string} op
 * @param {object} args
 * @param {number} timeoutMs
 */
async function callHost(op, args = {}, timeoutMs = 30000) {
  const request = JSON.stringify({ op, args });
  // Double-encode: the inner string is the JSON payload, the outer form is a
  // valid ExtendScript string literal with everything escaped.
  let script = `__mcp_exec(${JSON.stringify(request)})`;

  /*
   * A reload has to run at the TOP LEVEL of the script. $.evalFile defines
   * everything in its calling scope, so the host's old in-function evalFile
   * redefined the ops as locals that vanished on return - it never reloaded
   * anything, yet reported success. Top-level statements in an evalScript run
   * in the global scope the host was first loaded into. A failure is kept in
   * __mcp_reloadError for the reloadHost op to report, rather than collapsing
   * to "EvalScript error.".
   */
  if (op === 'reloadHost' && args && args.hostPath) {
    const file = JSON.stringify(String(args.hostPath));
    script =
      `try { $.evalFile(new File(${file})); __mcp_reloadError = null; } ` +
      `catch (e) { __mcp_reloadError = String(e) + (e.line ? ' (line ' + e.line + ')' : ''); }\n` +
      script;
  }

  const raced = await Promise.race([
    rawEval(script),
    new Promise((_, rej) =>
      setTimeout(() => rej(new Error(`Host op '${op}' timed out after ${timeoutMs}ms`)), timeoutMs)
    ),
  ]);

  if (raced === EVAL_ERROR || raced === undefined || raced === null) {
    return {
      ok: false,
      error: {
        code: 'evalscript_error',
        message:
          'evalScript failed opaquely. Usually means host.jsx did not load, ' +
          '__mcp_exec is undefined, or a syntax error in the payload.',
      },
    };
  }

  try {
    return JSON.parse(raced);
  } catch (err) {
    return {
      ok: false,
      error: { code: 'bad_host_reply', message: `Host returned non-JSON: ${String(raced).slice(0, 400)}` },
    };
  }
}

module.exports = { callHost, rawEval, EVAL_ERROR };

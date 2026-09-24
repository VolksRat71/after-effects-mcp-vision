const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CEP = path.join(__dirname, '..', '..', 'cep');

for (const page of ['index.html', 'server.html']) {
  test(`${page} decodes the extension root before requiring`, () => {
    const src = fs.readFileSync(path.join(CEP, page), 'utf8');
    assert.match(src, /fileURLToPath\(window\.location\.href/,
      `${page} must convert its file:// URL with fileURLToPath - it decodes %20 and keeps Windows drive letters`);
    assert.doesNotMatch(src, /=\s*decodeURIComponent\(window\.location\.pathname\)/,
      `${page} must not derive its root from location.pathname - on Windows that is "/C:/...", which no install could boot from`);
  });

  test(`${page} does not use a bare relative require for its entry module`, () => {
    const src = fs.readFileSync(path.join(CEP, page), 'utf8');
    assert.doesNotMatch(src, /require\('\.\/client\//,
      `${page} must require by decoded absolute path, not './client/...'`);
  });

  test(`${page} reports a boot failure rather than failing silently`, () => {
    const src = fs.readFileSync(path.join(CEP, page), 'utf8');
    assert.match(src, /boot\.log/, `${page} must write boot diagnostics to disk`);
  });
}

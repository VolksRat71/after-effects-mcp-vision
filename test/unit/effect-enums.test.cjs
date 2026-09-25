const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

/*
 * The generated popup table (scripts/gen-effect-enums.mjs). ExtendScript reads
 * a BOM-less .jsx in the system encoding, so a raw curly apostrophe would turn
 * into mojibake in an option label - and then a label write would never match.
 */
const file = path.join(__dirname, '../../cep/host/effect-enums.jsx');
const src = fs.readFileSync(file, 'utf8');

test('effect-enums.jsx is pure ASCII', () => {
  const bad = src.split('\n').map((l, i) => [i + 1, l]).filter(([, l]) => /[^\x00-\x7e]/.test(l));
  assert.deepStrictEqual(bad, [], `non-ASCII on lines ${bad.map(([n]) => n).join(', ')}`);
});

test('effect-enums.jsx defines a table of option lists keyed by parameter matchName', () => {
  const ctx = {};
  vm.runInNewContext(src, ctx);
  const t = ctx.__mcp_effectEnums;
  assert.ok(t && typeof t === 'object');
  // The table comes from another VM context, so compare as JSON rather than by prototype.
  assert.strictEqual(JSON.stringify(t['ADBE Stroke-0007']), JSON.stringify(['On Original Image', 'On Transparent', 'Reveal Original Image']));
  for (const [mn, opts] of Object.entries(t)) {
    assert.ok(Array.isArray(opts) && opts.length >= 2, `${mn} has fewer than two options`);
  }
});

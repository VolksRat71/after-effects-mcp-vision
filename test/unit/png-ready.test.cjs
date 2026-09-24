const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { readCompletePng, isCompletePng } = require('../../cep/server/png-ready.js');

/*
 * saveFrameToPng writes asynchronously; a 1920x1080 frame on Windows was read
 * at 66% of its rows. These write a real PNG in pieces, the way AE does.
 */
function crc32(buf) {
  let c, crc = 0xffffffff;
  for (const b of buf) { c = (crc ^ b) & 0xff; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crc = (crc >>> 8) ^ c; }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w = 64, h = 64) {
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const raw = Buffer.alloc((w * 4 + 1) * h, 0x7f);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'png-')), 'f.png');

test('a complete PNG is recognised; a truncated one is not', () => {
  const full = png();
  assert.strictEqual(isCompletePng(full), true);
  assert.strictEqual(isCompletePng(full.subarray(0, Math.floor(full.length * 0.66))), false);
});

test('waits while the file is written in pieces, then returns all of it', async () => {
  const f = tmp(), full = png(256, 256), cut = Math.floor(full.length * 0.66);
  fs.writeFileSync(f, full.subarray(0, cut));                       // what the old code would have read
  setTimeout(() => fs.appendFileSync(f, full.subarray(cut)), 120);
  const got = await readCompletePng(f, { timeoutMs: 3000, intervalMs: 10 });
  assert.strictEqual(got.length, full.length, 'must not return the partial file');
  assert.ok(got.equals(full));
});

test('waits for a file that does not exist yet', async () => {
  const f = tmp(), full = png();
  setTimeout(() => fs.writeFileSync(f, full), 80);
  assert.ok((await readCompletePng(f, { timeoutMs: 3000, intervalMs: 10 })).equals(full));
});

test('gives up with a clear error if the PNG never completes', async () => {
  const f = tmp(), full = png(); fs.writeFileSync(f, full.subarray(0, full.length - 12)); // everything but IEND
  await assert.rejects(readCompletePng(f, { timeoutMs: 150, intervalMs: 20 }), /not a complete PNG.*no IEND/);
});

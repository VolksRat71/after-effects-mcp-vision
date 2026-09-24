/*
 * Read a PNG only once After Effects has finished writing it.
 *
 * saveFrameToPng returns immediately and writes asynchronously, and the host
 * considers a frame ready as soon as the file has any bytes at all. A
 * 1920x1080 frame on Windows was read with only 66% of its rows written: no
 * IEND chunk, a truncated zlib stream, and the bottom third of the image
 * missing. Smaller frames, and the Mac, were fast enough to hide it.
 *
 * Every complete PNG ends with the same 12-byte IEND chunk, so its presence is
 * an exact completion signal - no guessing at sizes or stable-for-N-polls.
 */

const fs = require('fs');

// length (0) + "IEND" + CRC - identical in every PNG.
const IEND = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

function isCompletePng(buf) {
  return !!buf && buf.length > IEND.length && buf.subarray(buf.length - IEND.length).equals(IEND);
}

/**
 * @param {string} file
 * @param {{timeoutMs?: number, intervalMs?: number}} [opts]
 * @returns {Promise<Buffer>} the complete file
 */
async function readCompletePng(file, { timeoutMs = 15000, intervalMs = 25 } = {}) {
  const started = Date.now();
  let last = null;
  for (;;) {
    try { last = fs.readFileSync(file); } catch (e) { last = null; }
    if (isCompletePng(last)) return last;
    if (Date.now() - started >= timeoutMs) {
      throw new Error(`${file} was not a complete PNG after ${timeoutMs}ms ` +
        `(${last ? last.length : 0} bytes, no IEND) - saveFrameToPng writes asynchronously`);
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

module.exports = { readCompletePng, isCompletePng };

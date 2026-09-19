/*
 * Composites N captured frames into one labelled contact sheet.
 *
 * Runs on a <canvas> in the extension's CEF page rather than through a native
 * image library, so the .zxp ships no node_modules and no binary dependency.
 * Motion is precisely what a single still cannot show, and one sheet costs a
 * fraction of the context that N separate images would.
 */

const fs = require('fs');

function loadImage(filePath) {
  return new Promise((resolve, reject) => {
    const b64 = fs.readFileSync(filePath).toString('base64');
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Could not decode ${filePath}`));
    img.src = `data:image/png;base64,${b64}`;
  });
}

/**
 * @param {Array<{path:string,time:number}>} frames
 * @param {{columns?:number, label?:boolean}} options
 * @returns {Promise<{base64:string, width:number, height:number, columns:number, rows:number}>}
 */
async function buildContactSheet(frames, options = {}) {
  if (!frames.length) throw new Error('No frames to composite');

  const images = await Promise.all(frames.map((f) => loadImage(f.path)));
  const cellW = images[0].width;
  const cellH = images[0].height;
  const labelH = options.label === false ? 0 : 16;
  const columns = Math.max(1, Math.min(frames.length, options.columns || Math.ceil(Math.sqrt(frames.length))));
  const rows = Math.ceil(frames.length / columns);

  const canvas = document.createElement('canvas');
  canvas.width = columns * cellW;
  canvas.height = rows * (cellH + labelH);
  const ctx = canvas.getContext('2d');

  // Mid grey, not black or white: transparent regions in a capture would be
  // ambiguous against either, and "nothing drawn here" is a real finding.
  ctx.fillStyle = '#4a4a4a';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  images.forEach((img, i) => {
    const col = i % columns;
    const row = Math.floor(i / columns);
    const x = col * cellW;
    const y = row * (cellH + labelH);
    ctx.drawImage(img, x, y, cellW, cellH);

    if (labelH) {
      ctx.fillStyle = '#1e1e1e';
      ctx.fillRect(x, y + cellH, cellW, labelH);
      ctx.fillStyle = '#e0e0e0';
      ctx.font = '11px -apple-system, sans-serif';
      ctx.textBaseline = 'middle';
      ctx.fillText(`${frames[i].time.toFixed(2)}s`, x + 5, y + cellH + labelH / 2);
    }
  });

  const dataUrl = canvas.toDataURL('image/png');
  return {
    base64: dataUrl.replace(/^data:image\/png;base64,/, ''),
    width: canvas.width,
    height: canvas.height,
    columns,
    rows,
  };
}

module.exports = { buildContactSheet };

// Step 7 - thumbnail: an AI-generated hero image with bold overlay text,
// composited with sharp + SVG (prebuilt binaries - no node-canvas native
// build, no apt-get step in CI). Two variants are rendered; A is uploaded
// and both are kept as a CI artifact (the Data API can't run Studio's A/B test).
// Text is drawn with vector shapes + DejaVu Sans only: the runner has no
// emoji font (the fonts-noto-emoji apt line once broke every run for 3 days).
import path from 'path';
import { readFile } from 'fs/promises';
import sharp from 'sharp';
import { generateSceneImage } from '../lib/images.js';

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function wrap(text, maxChars) {
  const lines = [];
  let line = '';
  for (const w of text.split(/\s+/)) {
    if ((line + ' ' + w).trim().length > maxChars && line) { lines.push(line); line = w; } else line = (line + ' ' + w).trim();
  }
  if (line) lines.push(line);
  return lines.slice(0, 3);
}

function overlaySvg({ width, height, text, accent, flip }) {
  const vertical = height > width;
  const lines = wrap(text.toUpperCase(), vertical ? 10 : 14);
  const fontSize = Math.round((vertical ? width * 0.13 : height * 0.15));
  const lineH = fontSize * 1.08;
  const blockH = lines.length * lineH;
  const top = vertical ? height * (flip ? 0.12 : 0.62) : (height - blockH) / 2 + fontSize * 0.85;
  const x = vertical ? width / 2 : (flip ? width * 0.95 : width * 0.05);
  const anchor = vertical ? 'middle' : (flip ? 'end' : 'start');
  const shadeX = flip ? width * 0.4 : 0;
  const tspans = lines.map((l, i) =>
    `<text x="${x}" y="${top + i * lineH}" text-anchor="${anchor}" font-family="DejaVu Sans" font-weight="bold" font-size="${fontSize}"
      fill="${i === 0 ? accent : '#ffffff'}" stroke="#000" stroke-width="${fontSize * 0.09}" paint-order="stroke">${esc(l)}</text>`).join('');
  return Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><linearGradient id="s" x1="${flip ? 1 : 0}" y1="0" x2="${flip ? 0 : 1}" y2="0">
      <stop offset="0" stop-color="#000" stop-opacity="0.65"/><stop offset="1" stop-color="#000" stop-opacity="0"/></linearGradient></defs>
    ${vertical ? '' : `<rect x="${shadeX}" y="0" width="${width * 0.6}" height="${height}" fill="url(#s)"/>`}
    <rect x="0" y="${height - height * 0.025}" width="${width}" height="${height * 0.025}" fill="${accent}"/>
    ${tspans}
  </svg>`);
}

async function compose(baseBuffer, size, text, accent, flip, out) {
  await sharp(baseBuffer)
    .resize(size.width, size.height, { fit: 'cover', position: flip ? 'left' : 'attention' })
    .modulate({ saturation: 1.15, brightness: 1.03 })
    .composite([{ input: overlaySvg({ ...size, text, accent, flip }) }])
    .jpeg({ quality: 86, mozjpeg: true })
    .toFile(out);
  return out;
}

export async function generateThumbnail(channel, script, seo, workDir) {
  const vertical = channel.format === 'short';
  const size = vertical ? { width: 1080, height: 1920 } : { width: 1280, height: 720 };
  let base;
  if (vertical) {
    base = await readFile(script.scenes[0].image); // reuse the hook image - saves free quota
  } else {
    const prompt = `${script.scenes[0].visual}. Eye-catching YouTube thumbnail composition, main subject large and on the right third, `
      + `high contrast, vivid colors, clean empty area on the left. Style: ${channel.artStyle}. No text, no letters, no watermark.`;
    base = (await generateSceneImage(prompt, { width: 1344, height: 768, model: channel.imageModel })).buffer;
  }
  const text = seo.thumbnailText || seo.title.split(' ').slice(0, 4).join(' ');
  const primary = await compose(base, size, text, channel.brandColorB || '#ffd400', false, path.join(workDir, 'thumb-A.jpg'));
  // B always uses high-contrast yellow - brand colours can be too dark to read
  const variantB = await compose(base, size, text, '#ffe14d', true, path.join(workDir, 'thumb-B.jpg'));
  return { primary, variantB };
}

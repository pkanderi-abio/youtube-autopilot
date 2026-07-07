// Step 6 - a simple, on-brand thumbnail: gradient background (matching
// the channel's colors) + the video title, bold and large. No CTR
// modeling here (that's a real ML problem) - this is a clean, readable
// default. Swap in YouTube's built-in "Test & compare" thumbnails
// feature manually if you want real A/B data later.
import { createCanvas } from 'canvas';
import { writeFile } from 'fs/promises';
import path from 'path';

function wrapText(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export async function generateThumbnail(channel, title, workDir) {
  const w = 1280, h = 720;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, channel.brandColorA);
  grad.addColorStop(1, channel.brandColorB);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // subtle dark scrim for text legibility
  const scrim = ctx.createLinearGradient(0, h * 0.4, 0, h);
  scrim.addColorStop(0, 'rgba(0,0,0,0)');
  scrim.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = scrim;
  ctx.fillRect(0, 0, w, h);

  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 76px sans-serif';
  ctx.textBaseline = 'bottom';
  const lines = wrapText(ctx, title.toUpperCase(), w - 140).slice(0, 3);
  const lineHeight = 88;
  let y = h - 60;
  for (let i = lines.length - 1; i >= 0; i--) {
    ctx.fillText(lines[i], 70, y);
    y -= lineHeight;
  }

  const outPath = path.join(workDir, 'thumbnail.png');
  await writeFile(outPath, canvas.toBuffer('image/png'));
  return outPath;
}

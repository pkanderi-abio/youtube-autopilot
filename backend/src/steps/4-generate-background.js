// Step 4 - an on-brand animated background: a two-color gradient using
// the channel's own brand colors, with a slow Ken Burns zoom so the
// frame has real motion without relying on stock footage or a generic
// ffmpeg test pattern (which is what this used to be - a calibration
// color-bar/gradient test card, not real content).
import path from 'path';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'child_process';
import { createCanvas } from 'canvas';
import { writeFile } from 'fs/promises';

function renderGradientFrame(w, h, colorA, colorB) {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');

  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, colorA);
  grad.addColorStop(1, colorB);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // soft vignette so the zoomed frame reads as a scene, not a flat swatch
  const vignette = ctx.createRadialGradient(w / 2, h * 0.4, 0, w / 2, h * 0.4, Math.max(w, h) * 0.75);
  vignette.addColorStop(0, 'rgba(255,255,255,0.08)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.25)');
  ctx.fillStyle = vignette;
  ctx.fillRect(0, 0, w, h);

  return canvas.toBuffer('image/png');
}

export async function generateBackground(channel, durationSeconds, workDir) {
  const w = channel.format === 'short' ? 1080 : 1920;
  const h = channel.format === 'short' ? 1920 : 1080;
  const fps = 25;

  const framePath = path.join(workDir, 'bg-frame.png');
  await writeFile(framePath, renderGradientFrame(w, h, channel.brandColorA, channel.brandColorB));

  const outPath = path.join(workDir, 'bg-video.mp4');
  const maxZoom = 1.15;
  const zoomPerFrame = (maxZoom - 1) / (fps * durationSeconds);

  const args = [
    '-y',
    '-loop', '1',
    '-i', framePath,
    '-t', String(durationSeconds),
    '-vf', `zoompan=z='min(zoom+${zoomPerFrame},${maxZoom})':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${w}x${h}:fps=${fps},format=yuv420p`,
    '-c:v', 'libx264',
    outPath
  ];

  await new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args);
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error('ffmpeg background failed: ' + stderr)));
  });

  return outPath;
}

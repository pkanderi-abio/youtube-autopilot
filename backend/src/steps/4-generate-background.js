// Step 4 - the video's visual track. Two paths:
//  - "gradient" (default): an on-brand two-color gradient with a slow
//    Ken Burns zoom - real motion without stock footage or a generic
//    ffmpeg test pattern.
//  - "illustrated" (channels with visualStyle "illustrated" + a script
//    that produced `scenes`): one AI-generated illustration per scene,
//    each Ken-Burns zoomed for its slice of the runtime, concatenated
//    into a single background video. A failed scene image falls back to
//    the gradient frame rather than failing the whole run.
import path from 'path';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'child_process';
import { createCanvas } from 'canvas';
import { writeFile } from 'fs/promises';
import { generateSceneImage } from '../lib/images.js';

const STYLE_SUFFIX = ", flat 2D children's book illustration, bright cheerful colors, "
  + 'simple rounded friendly shapes, thick clean outlines, no text or letters '
  + 'in the image, single clear focal subject, simple plain background';

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

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args);
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error('ffmpeg failed: ' + stderr)));
  });
}

async function zoomClip(framePath, outPath, w, h, fps, durationSeconds) {
  const maxZoom = 1.15;
  const zoomPerFrame = (maxZoom - 1) / (fps * durationSeconds);

  await runFfmpeg([
    '-y',
    '-loop', '1',
    '-i', framePath,
    '-t', String(durationSeconds),
    '-vf', `zoompan=z='min(zoom+${zoomPerFrame},${maxZoom})':d=1:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=${w}x${h}:fps=${fps},format=yuv420p`,
    '-c:v', 'libx264',
    outPath
  ]);
}

function computeSceneDurations(totalDuration, count) {
  const base = totalDuration / count;
  const durations = new Array(count).fill(base);
  // small safety buffer so the concatenated background is never shorter
  // than the narration (assembleVideo muxes with -shortest)
  durations[count - 1] += 0.5;
  return durations;
}

async function generateIllustratedBackground(channel, durationSeconds, workDir, scenes, w, h, fps) {
  const durations = computeSceneDurations(durationSeconds, scenes.length);
  const clipPaths = [];

  for (let i = 0; i < scenes.length; i++) {
    const framePath = path.join(workDir, `scene-${i}.png`);
    try {
      const buffer = await generateSceneImage(scenes[i] + STYLE_SUFFIX, { width: w, height: h });
      await writeFile(framePath, buffer);
    } catch (err) {
      console.warn(`[background] scene ${i} image generation failed, using gradient fallback:`, err.message);
      await writeFile(framePath, renderGradientFrame(w, h, channel.brandColorA, channel.brandColorB));
    }

    const clipPath = path.join(workDir, `scene-${i}.mp4`);
    await zoomClip(framePath, clipPath, w, h, fps, durations[i]);
    clipPaths.push(clipPath);
  }

  const listPath = path.join(workDir, 'concat-list.txt');
  const escapePath = (p) => p.replace(/\\/g, '/').replace(/'/g, "'\\''");
  await writeFile(listPath, clipPaths.map((p) => `file '${escapePath(p)}'`).join('\n'), 'utf8');

  const outPath = path.join(workDir, 'bg-video.mp4');
  await runFfmpeg(['-y', '-f', 'concat', '-safe', '0', '-i', listPath, '-c', 'copy', outPath]);
  return outPath;
}

export async function generateBackground(channel, durationSeconds, workDir, scenes = []) {
  const w = channel.format === 'short' ? 1080 : 1920;
  const h = channel.format === 'short' ? 1920 : 1080;
  const fps = 25;

  if (channel.visualStyle === 'illustrated' && scenes.length) {
    return generateIllustratedBackground(channel, durationSeconds, workDir, scenes, w, h, fps);
  }

  const framePath = path.join(workDir, 'bg-frame.png');
  await writeFile(framePath, renderGradientFrame(w, h, channel.brandColorA, channel.brandColorB));

  const outPath = path.join(workDir, 'bg-video.mp4');
  await zoomClip(framePath, outPath, w, h, fps, durationSeconds);
  return outPath;
}

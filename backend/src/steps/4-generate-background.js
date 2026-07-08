// Step 4 - the video's visual track: a sequence of short shots (like a
// real short-form edit), not one continuous background for the whole
// runtime. Each shot is either an AI-generated illustration (illustrated
// channels, one per script scene) or an on-brand gradient variant, and
// each gets its own fast zoom+pan toward a different focus point so
// consecutive shots read as visually distinct - not a single slowly-
// creeping background, which upstream testing showed was imperceptible
// over a 45s+ clip (measured video bitrate near-zero - i.e. frames were
// almost identical start to end). A failed illustration falls back to a
// gradient shot rather than failing the whole run.
import path from 'path';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'child_process';
import { createCanvas } from 'canvas';
import { writeFile } from 'fs/promises';
import { generateSceneImage } from '../lib/images.js';
import { findStockFootageClip } from '../lib/stockFootage.js';

// A handful of on-brand gradient looks + off-center focus points to
// cycle through, so consecutive fallback/plain-gradient shots don't
// look identical to each other.
const GRADIENT_VARIANTS = [
  { axis: 'diagonal', reverse: false },
  { axis: 'vertical', reverse: false },
  { axis: 'diagonal', reverse: true },
  { axis: 'horizontal', reverse: false },
  { axis: 'radial', reverse: false },
  { axis: 'vertical', reverse: true }
];

const FOCUS_POINTS = [
  [0.3, 0.35], [0.7, 0.65], [0.5, 0.2], [0.25, 0.7], [0.75, 0.3], [0.5, 0.8]
];

function hexToRgb(hex) {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  let h = 0, s = 0;
  const l = (max + min) / 2;
  const d = max - min;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    switch (max) {
      case r: h = 60 * (((g - b) / d) % 6); break;
      case g: h = 60 * ((b - r) / d + 2); break;
      default: h = 60 * ((r - g) / d + 4);
    }
  }
  if (h < 0) h += 360;
  return [h, s, l];
}

function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs((h / 60) % 2 - 1));
  const m = l - c / 2;
  let [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x]
    : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
}

// A bold, clearly-different-hued accent color per shot index (golden-
// angle hue rotation from the brand color, forced to a vivid saturation/
// lightness) - so shots read as visually distinct even when the brand's
// two colors are close together (e.g. navy-to-blue), where blending
// only between colorA/colorB barely changes anything.
function accentColor(baseHex, index) {
  const [r, g, b] = hexToRgb(baseHex);
  const [h] = rgbToHsl(r, g, b);
  const hue = (h + index * 137.5) % 360;
  return hslToRgb(hue, 0.75, 0.55);
}

// Deterministic pseudo-random in [0,1), seeded so the same shot index
// always renders the same blob layout (stable if a frame is regenerated).
function seededRandom(seed) {
  let s = seed;
  return () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280;
  };
}

function renderGradientFrame(w, h, colorA, colorB, variantIndex = 0) {
  const variant = GRADIENT_VARIANTS[variantIndex % GRADIENT_VARIANTS.length];
  const [c1, c2] = variant.reverse ? [colorB, colorA] : [colorA, colorB];

  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');

  let grad;
  if (variant.axis === 'vertical') grad = ctx.createLinearGradient(0, 0, 0, h);
  else if (variant.axis === 'horizontal') grad = ctx.createLinearGradient(0, 0, w, 0);
  else if (variant.axis === 'radial') grad = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.75);
  else grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, c1);
  grad.addColorStop(1, c2);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // bold, vividly-hued blobs (not just tints of the brand colors) so the
  // zoom/pan reveals real visual change even when colorA/colorB are close
  // in hue - a same-family blend was measured as nearly imperceptible.
  const rand = seededRandom(variantIndex * 97 + 13);
  for (let i = 0; i < 3; i++) {
    const [ar, ag, ab] = accentColor(colorA, variantIndex + i);
    const bx = rand() * w;
    const by = rand() * h;
    const radius = (0.28 + rand() * 0.25) * Math.max(w, h);
    const blob = ctx.createRadialGradient(bx, by, 0, bx, by, radius);
    blob.addColorStop(0, `rgba(${ar},${ag},${ab},0.6)`);
    blob.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = blob;
    ctx.fillRect(0, 0, w, h);
  }

  const [fx, fy] = FOCUS_POINTS[variantIndex % FOCUS_POINTS.length];
  const vignette = ctx.createRadialGradient(w * fx, h * fy, 0, w * fx, h * fy, Math.max(w, h) * 0.8);
  vignette.addColorStop(0, 'rgba(255,255,255,0.10)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.35)');
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

// Fast Ken Burns zoom+pan toward [fx, fy] (fractions of width/height).
// maxZoom/duration are tuned per-shot (not per whole video) so the
// motion is clearly visible within a single ~7s shot instead of being
// spread thin across the entire runtime.
async function zoomClip(framePath, outPath, w, h, fps, durationSeconds, focus) {
  const [fx, fy] = focus;
  const maxZoom = 1.5;
  const totalFrames = Math.round(fps * durationSeconds);
  const zoomPerFrame = (maxZoom - 1) / totalFrames;

  // `d` here is the number of output frames zoompan generates per INPUT
  // frame it receives. With a single looped static image there's only
  // ever one true input frame, so d must be the *entire* output frame
  // count - not 1 - or zoompan evaluates its zoom/pan expression exactly
  // once and then just holds that single frame for the rest of the clip
  // (confirmed via pixel-diffing test output: d=1 produced a byte-for-
  // byte frozen video here despite a "correct"-looking zoom expression).
  await runFfmpeg([
    '-y',
    '-sws_flags', 'lanczos',
    '-loop', '1',
    '-i', framePath,
    '-t', String(durationSeconds),
    '-vf', `zoompan=z='min(zoom+${zoomPerFrame},${maxZoom})':x='(iw-iw/zoom)*${fx}':y='(ih-ih/zoom)*${fy}':d=${totalFrames}:s=${w}x${h}:fps=${fps},format=yuv420p`,
    '-c:v', 'libx264',
    '-crf', '18',
    '-preset', 'medium',
    outPath
  ]);
}

// Real stock footage clip: cover-scale+crop to the target frame (never
// distort aspect ratio), loop if the source is shorter than the shot's
// duration, trim to exactly durationSeconds, and drop its own audio -
// the final mix only ever uses the narration track, muxed in later by
// assembleVideo. Encoded with the same params as zoomClip() (fps,
// yuv420p, libx264 crf 18) so concatClips' `-c copy` demuxer can stitch
// real-footage and gradient/illustration shots together in one video.
async function footageClip(sourcePath, outPath, w, h, fps, durationSeconds) {
  await runFfmpeg([
    '-y',
    '-stream_loop', '-1',
    '-i', sourcePath,
    '-t', String(durationSeconds),
    '-vf', `scale=w=${w}:h=${h}:force_original_aspect_ratio=increase,crop=${w}:${h},fps=${fps},format=yuv420p`,
    '-an',
    '-c:v', 'libx264',
    '-crf', '18',
    '-preset', 'medium',
    outPath
  ]);
}

function computeShotDurations(totalDuration, count) {
  const base = totalDuration / count;
  const durations = new Array(count).fill(base);
  // small safety buffer so the concatenated background is never shorter
  // than the narration (assembleVideo muxes with -shortest)
  durations[count - 1] += 0.5;
  return durations;
}

async function concatClips(clipPaths, workDir) {
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

  const illustrated = channel.visualStyle === 'illustrated' && scenes.length > 0;
  const stockFootage = channel.visualStyle === 'stockFootage' && scenes.length > 0;
  const shotCount = (illustrated || stockFootage) ? scenes.length : Math.max(3, Math.round(durationSeconds / 7));
  const durations = computeShotDurations(durationSeconds, shotCount);

  // Every gradient variant/color/blob choice below is keyed off
  // "shotSeed", not the raw shot index - without this, shot 0 of every
  // single video renders pixel-identical (same variant, same accent hue,
  // same blob layout), since it's always "index 0". That made every
  // video's thumbnail (always generated from shot 0) and opening seconds
  // look the same across the whole channel, even though shots *within*
  // one video legitimately varied. Confirmed by comparing actual
  // YouTube Studio thumbnails, which were all near-identical.
  const runSeed = Math.floor(Math.random() * 100000);

  const clipPaths = [];
  for (let i = 0; i < shotCount; i++) {
    const shotSeed = runSeed + i;
    const clipPath = path.join(workDir, `scene-${i}.mp4`);

    if (stockFootage) {
      try {
        const sourcePath = path.join(workDir, `stock-source-${i}.mp4`);
        const buffer = await findStockFootageClip(scenes[i], { width: w, height: h });
        await writeFile(sourcePath, buffer);
        await footageClip(sourcePath, clipPath, w, h, fps, durations[i]);
        clipPaths.push(clipPath);
        continue;
      } catch (err) {
        console.warn(`[background] scene ${i} stock footage failed, using gradient fallback:`, err.message);
      }
    }

    const framePath = path.join(workDir, `scene-${i}.png`);
    let isRealIllustration = false;

    if (illustrated) {
      try {
        const buffer = await generateSceneImage(scenes[i], { width: w, height: h });
        await writeFile(framePath, buffer);
        isRealIllustration = true;
      } catch (err) {
        console.warn(`[background] scene ${i} image generation failed, using gradient fallback:`, err.message);
      }
    }

    if (!isRealIllustration) {
      await writeFile(framePath, renderGradientFrame(w, h, channel.brandColorA, channel.brandColorB, shotSeed));
    }

    // real illustrations get a centered zoom (no clue where the subject
    // is); gradient shots pan toward a varied off-center point for
    // visible, distinct motion per shot.
    const focus = isRealIllustration ? [0.5, 0.5] : FOCUS_POINTS[shotSeed % FOCUS_POINTS.length];
    await zoomClip(framePath, clipPath, w, h, fps, durations[i], focus);
    clipPaths.push(clipPath);
  }

  return concatClips(clipPaths, workDir);
}

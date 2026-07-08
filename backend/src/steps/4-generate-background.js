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

const STYLE_SUFFIX = ", flat 2D children's book illustration, bright cheerful colors, "
  + 'simple rounded friendly shapes, thick clean outlines, no text or letters '
  + 'in the image, single clear focal subject, simple plain background';

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

  // soft color blobs so the zoom/pan actually reveals texture instead of
  // panning across an untextured flat gradient (which barely changes)
  const [rA, gA, bA] = hexToRgb(colorA);
  const [rB, gB, bB] = hexToRgb(colorB);
  const rand = seededRandom(variantIndex * 97 + 13);
  for (let i = 0; i < 4; i++) {
    const t = rand();
    const blobColor = `rgba(${Math.round(rA + (rB - rA) * t)},${Math.round(gA + (gB - gA) * t)},${Math.round(bA + (bB - bA) * t)},0.35)`;
    const bx = rand() * w;
    const by = rand() * h;
    const radius = (0.18 + rand() * 0.22) * Math.max(w, h);
    const blob = ctx.createRadialGradient(bx, by, 0, bx, by, radius);
    blob.addColorStop(0, blobColor);
    blob.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = blob;
    ctx.fillRect(0, 0, w, h);
  }

  const [fx, fy] = FOCUS_POINTS[variantIndex % FOCUS_POINTS.length];
  const vignette = ctx.createRadialGradient(w * fx, h * fy, 0, w * fx, h * fy, Math.max(w, h) * 0.8);
  vignette.addColorStop(0, 'rgba(255,255,255,0.10)');
  vignette.addColorStop(1, 'rgba(0,0,0,0.30)');
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
    '-loop', '1',
    '-i', framePath,
    '-t', String(durationSeconds),
    '-vf', `zoompan=z='min(zoom+${zoomPerFrame},${maxZoom})':x='(iw-iw/zoom)*${fx}':y='(ih-ih/zoom)*${fy}':d=${totalFrames}:s=${w}x${h}:fps=${fps},format=yuv420p`,
    '-c:v', 'libx264',
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
  const shotCount = illustrated ? scenes.length : Math.max(3, Math.round(durationSeconds / 7));
  const durations = computeShotDurations(durationSeconds, shotCount);

  const clipPaths = [];
  for (let i = 0; i < shotCount; i++) {
    const framePath = path.join(workDir, `scene-${i}.png`);
    let isRealIllustration = false;

    if (illustrated) {
      try {
        const buffer = await generateSceneImage(scenes[i] + STYLE_SUFFIX, { width: w, height: h });
        await writeFile(framePath, buffer);
        isRealIllustration = true;
      } catch (err) {
        console.warn(`[background] scene ${i} image generation failed, using gradient fallback:`, err.message);
      }
    }

    if (!isRealIllustration) {
      await writeFile(framePath, renderGradientFrame(w, h, channel.brandColorA, channel.brandColorB, i));
    }

    // real illustrations get a centered zoom (no clue where the subject
    // is); gradient shots pan toward a varied off-center point for
    // visible, distinct motion per shot.
    const focus = isRealIllustration ? [0.5, 0.5] : FOCUS_POINTS[i % FOCUS_POINTS.length];
    const clipPath = path.join(workDir, `scene-${i}.mp4`);
    await zoomClip(framePath, clipPath, w, h, fps, durations[i], focus);
    clipPaths.push(clipPath);
  }

  return concatClips(clipPaths, workDir);
}

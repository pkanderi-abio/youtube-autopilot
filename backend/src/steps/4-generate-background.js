// Step 4 - the video's visual track: a sequence of short shots (like a
// real short-form edit), not one continuous background for the whole
// runtime. Each shot is either real stock footage (one per script scene)
// or an on-brand gradient variant, and each gets its own fast zoom+pan
// toward a different focus point so consecutive shots read as visually
// distinct - not a single slowly-creeping background, which upstream
// testing showed was imperceptible over a 45s+ clip (measured video
// bitrate near-zero - i.e. frames were almost identical start to end).
// A failed footage fetch falls back to a gradient shot rather than
// failing the whole run.
import path from 'path';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'child_process';
import { createCanvas } from 'canvas';
import { writeFile, mkdir } from 'fs/promises';
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

// ---- procedural cartoon animation (visualStyle: "cartoonAnimation") ----
// Draws bright, kid-friendly moving shapes per frame using node-canvas
// and streams each PNG straight into ffmpeg over image2pipe - no temp
// PNGs on disk. Each shot classifies its scene text (number / color /
// letter / default) and picks a scene-appropriate renderer, so a
// "counting from 1 to 3" script produces a big animated "3" surrounded
// by 3 orbiting shapes, "red apple" produces a red-tinted background
// with a red central shape, etc. Fully $0, no external assets, and
// the encoder params match footageClip/zoomClip so the resulting mp4
// concats cleanly with any other clip type in the same video.

const KID_COLORS = {
  red: '#e63946', blue: '#457b9d', green: '#2a9d8f', yellow: '#f1c40f',
  orange: '#f39c12', purple: '#8e44ad', pink: '#ff6f91',
  brown: '#7c4a1f'
};

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10
};

function classifyCartoonScene(text) {
  const lower = (text || '').toLowerCase();
  const digit = (text || '').match(/\b(\d+)\b/);
  if (digit) {
    const n = parseInt(digit[1], 10);
    if (n >= 1 && n <= 20) return { kind: 'number', value: n };
  }
  for (const [word, val] of Object.entries(NUMBER_WORDS)) {
    if (new RegExp('\\b' + word + '\\b').test(lower)) return { kind: 'number', value: val };
  }
  for (const [word, hex] of Object.entries(KID_COLORS)) {
    if (new RegExp('\\b' + word + '\\b').test(lower)) return { kind: 'color', hex };
  }
  const letter = lower.match(/\bletter\s+([a-z])\b/);
  if (letter) return { kind: 'letter', value: letter[1].toUpperCase() };
  return { kind: 'default' };
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawStar(ctx, cx, cy, r, color) {
  ctx.fillStyle = color;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = Math.max(2, r * 0.08);
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const rr = i % 2 === 0 ? r : r * 0.42;
    const angle = -Math.PI / 2 + i * (Math.PI / 5);
    const x = cx + Math.cos(angle) * rr;
    const y = cy + Math.sin(angle) * rr;
    if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

function drawHeart(ctx, cx, cy, r, color) {
  ctx.fillStyle = color;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = Math.max(2, r * 0.08);
  ctx.beginPath();
  ctx.moveTo(cx, cy + r * 0.3);
  ctx.bezierCurveTo(cx + r, cy - r * 0.6, cx + r * 1.5, cy + r * 0.3, cx, cy + r);
  ctx.bezierCurveTo(cx - r * 1.5, cy + r * 0.3, cx - r, cy - r * 0.6, cx, cy + r * 0.3);
  ctx.closePath();
  ctx.fill();
  ctx.stroke();
}

function drawCircle(ctx, cx, cy, r, color) {
  ctx.fillStyle = color;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = Math.max(2, r * 0.08);
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
}

function drawSquare(ctx, cx, cy, r, color, angle = 0) {
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  ctx.fillStyle = color;
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = Math.max(2, r * 0.08);
  ctx.fillRect(-r, -r, r * 2, r * 2);
  ctx.strokeRect(-r, -r, r * 2, r * 2);
  ctx.restore();
}

function drawShape(ctx, kind, cx, cy, r, color, angle = 0) {
  if (kind === 0) drawCircle(ctx, cx, cy, r, color);
  else if (kind === 1) drawStar(ctx, cx, cy, r, color);
  else if (kind === 2) drawHeart(ctx, cx, cy, r, color);
  else drawSquare(ctx, cx, cy, r, color, angle);
}

function drawSceneCaption(ctx, w, h, text) {
  if (!text) return;
  const isPortrait = h > w;
  const fontSize = Math.round((isPortrait ? w : h) * 0.055);
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  const padding = fontSize * 0.6;
  const measured = ctx.measureText(text);
  const pillW = Math.min(w * 0.92, measured.width + padding * 2);
  const pillH = fontSize * 1.6;
  const pillX = (w - pillW) / 2;
  const pillY = h - pillH - h * 0.05;

  ctx.fillStyle = 'rgba(255, 255, 255, 0.94)';
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.15)';
  ctx.lineWidth = 3;
  roundRect(ctx, pillX, pillY, pillW, pillH, pillH / 2);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = '#2b2b2b';
  ctx.fillText(text, w / 2, pillY + pillH / 2);
}

function drawNumberScene(ctx, w, h, n, t, seed) {
  const bounce = Math.sin(t * Math.PI * 6) * (h * 0.03);
  const size = Math.min(w, h) * 0.55;
  const cx = w / 2;
  const cy = h * 0.42;

  ctx.font = `bold ${Math.round(size)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = size * 0.06;
  ctx.strokeText(String(n), cx, cy + bounce);
  ctx.fillStyle = '#ff4d6d';
  ctx.fillText(String(n), cx, cy + bounce);

  const orbitR = size * 0.75;
  const count = Math.min(n, 12);
  for (let i = 0; i < count; i++) {
    const angle = (i / count) * Math.PI * 2 + t * Math.PI * 2;
    const x = cx + Math.cos(angle) * orbitR;
    const y = cy + Math.sin(angle) * orbitR + bounce;
    const hue = (i * 51 + seed * 20) % 360;
    drawShape(ctx, i % 4, x, y, size * 0.09, `hsl(${hue}, 80%, 60%)`, angle);
  }
}

function drawColorScene(ctx, w, h, colorHex, t, seed) {
  const bounce = Math.sin(t * Math.PI * 4) * (h * 0.04);
  const size = Math.min(w, h) * 0.32;
  const cx = w / 2;
  const cy = h * 0.42 + bounce;
  const shapeKind = seed % 4;
  drawShape(ctx, shapeKind, cx, cy, size, colorHex, t * Math.PI * 2);

  const rand = seededRandom(seed * 41);
  for (let i = 0; i < 8; i++) {
    const sx = rand() * w;
    const sy = rand() * (h * 0.82);
    const ph = rand() * Math.PI * 2;
    const dx = Math.cos(t * Math.PI * 2 + ph) * (w * 0.03);
    const dy = Math.sin(t * Math.PI * 2 + ph) * (h * 0.02);
    drawShape(ctx, i % 4, sx + dx, sy + dy, size * 0.17, colorHex, ph + t * 2);
  }
}

function drawLetterScene(ctx, w, h, letter, t, seed) {
  const bounce = Math.sin(t * Math.PI * 6) * (h * 0.03);
  const size = Math.min(w, h) * 0.55;
  const cx = w / 2;
  const cy = h * 0.42;
  ctx.font = `bold ${Math.round(size)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = size * 0.06;
  ctx.strokeText(letter, cx, cy + bounce);
  ctx.fillStyle = '#457b9d';
  ctx.fillText(letter, cx, cy + bounce);

  for (let i = 0; i < 6; i++) {
    const angle = (i / 6) * Math.PI * 2 + t * Math.PI;
    const r = size * 0.72;
    const x = cx + Math.cos(angle) * r;
    const y = cy + Math.sin(angle) * r + bounce;
    drawStar(ctx, x, y, size * 0.09, `hsl(${(i * 60 + seed * 30) % 360}, 85%, 60%)`);
  }
}

function drawShapesParty(ctx, w, h, seed, t) {
  const rand = seededRandom(seed);
  const N = 7;
  for (let i = 0; i < N; i++) {
    const baseX = rand() * w;
    const baseY = rand() * (h * 0.82);
    const size = (0.08 + rand() * 0.1) * Math.min(w, h);
    const phase = rand() * Math.PI * 2;
    const dx = Math.sin(t * Math.PI * 4 + phase) * (w * 0.08);
    const dy = Math.cos(t * Math.PI * 3 + phase) * (h * 0.05);
    const hue = (i * 51 + seed * 30) % 360;
    drawShape(ctx, i % 4, baseX + dx, baseY + dy, size, `hsl(${hue}, 82%, 58%)`, phase + t * 3);
  }
}

function hueForHex(hex) {
  const [r, g, b] = hexToRgb(hex);
  return rgbToHsl(r, g, b)[0];
}

function renderCartoonFrameToCanvas(w, h, scene, frameIndex, totalFrames, seed) {
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const t = totalFrames > 1 ? frameIndex / (totalFrames - 1) : 0;
  const type = classifyCartoonScene(scene);

  // hueForHex CAN return NaN if the hex string is malformed - guard so a
  // single unexpected value never NaNs the whole HSL gradient (which
  // some canvas builds silently render as fully transparent, i.e. empty
  // frame). Fall back to a seeded hue in that case.
  let bgHue = type.kind === 'color' ? hueForHex(type.hex) : (seed * 47) % 360;
  if (!Number.isFinite(bgHue)) bgHue = (seed * 47) % 360;
  bgHue = Math.round(bgHue);
  const bg = ctx.createLinearGradient(0, 0, w, h);
  bg.addColorStop(0, `hsl(${bgHue}, 65%, 84%)`);
  bg.addColorStop(1, `hsl(${(bgHue + 40) % 360}, 65%, 92%)`);
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, w, h);

  if (type.kind === 'number') drawNumberScene(ctx, w, h, type.value, t, seed);
  else if (type.kind === 'color') drawColorScene(ctx, w, h, type.hex, t, seed);
  else if (type.kind === 'letter') drawLetterScene(ctx, w, h, type.value, t, seed);
  else drawShapesParty(ctx, w, h, seed, t);

  drawSceneCaption(ctx, w, h, scene);
  return canvas;
}

// Writes rendered PNG frames to a per-shot dir and encodes them via
// ffmpeg's standard image-sequence input (-i frame-%05d.png). This
// replaced an earlier image2pipe approach that silently produced a
// broken bg-video.mp4 on the first live baby-content run: the concat'd
// PNG stream that node-canvas emits was rejected somewhere in the
// image2pipe demux path and the whole cartoon path fell through to the
// gradient fallback, so the uploaded short had brand-gradient shots
// and a brand-gradient thumbnail even though the code "succeeded".
// Disk-based sequences are the well-worn ffmpeg pattern - orders of
// magnitude more reliable than stdin-streamed images. workDir is
// mkdtemp'd and rm -rf'd by run-pipeline.js, so the temp PNGs are
// cleaned automatically.
// Encoder settings intentionally identical to footageClip/zoomClip so
// concatClips' -c copy step can stitch cartoon shots together with
// stock-footage or gradient shots in the same output.
async function cartoonClip(scene, outPath, workDir, shotIndex, w, h, fps, durationSeconds, seed) {
  const totalFrames = Math.max(1, Math.round(fps * durationSeconds));
  const frameDir = path.join(workDir, `cartoon-${shotIndex}`);
  await mkdir(frameDir, { recursive: true });

  console.log(`[cartoon] shot ${shotIndex}: rendering ${totalFrames} frames at ${w}x${h} for "${scene}"`);
  const startedAt = Date.now();

  // Frames are encoded as JPEG rather than PNG. PNG output via
  // canvas.toBuffer worked fine locally with canvas v3.x, but the
  // production canvas^2.11 build against the Ubuntu CI runner's Cairo
  // silently produced PNGs that ffmpeg's image demuxer rejected -
  // whole cartoon path fell through to gradient, uploaded broken
  // videos twice in a row before we caught it. JPEG uses libjpeg-
  // turbo (a totally separate encode path from PNG/Cairo) and is the
  // long-standing standard for frame sequences. Slight quality trade
  // is invisible on baby-cartoon flat colors.
  // scene-0 still needs to be a real PNG (step 6's thumbnail loader
  // is content-detecting but the filename is hardcoded), so we
  // extract that from the same canvas once, without re-rendering.
  let firstFramePngBuf = null;
  for (let i = 0; i < totalFrames; i++) {
    const canvas = renderCartoonFrameToCanvas(w, h, scene, i, totalFrames, seed);
    if (i === 0) firstFramePngBuf = canvas.toBuffer('image/png');
    const jpegBuf = canvas.toBuffer('image/jpeg', { quality: 0.92 });
    await writeFile(path.join(frameDir, `frame-${String(i).padStart(5, '0')}.jpg`), jpegBuf);
  }
  const renderMs = Date.now() - startedAt;
  console.log(`[cartoon] shot ${shotIndex}: ${totalFrames} frames rendered in ${renderMs}ms, encoding...`);

  await runFfmpeg([
    '-y',
    '-framerate', String(fps),
    '-i', path.join(frameDir, 'frame-%05d.jpg'),
    '-t', String(durationSeconds),
    '-vf', 'format=yuv420p',
    '-c:v', 'libx264',
    '-crf', '18',
    '-preset', 'medium',
    '-r', String(fps),
    outPath
  ]);

  console.log(`[cartoon] shot ${shotIndex}: encoded ${outPath}`);
  return firstFramePngBuf;
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

// generateThumbnail (step 6) looks for workDir/scene-0.png to use a real
// frame instead of a plain brand-gradient thumbnail - grab one from the
// first stock-footage shot the same way it previously used the first
// illustrated scene's image.
async function extractFrame(videoPath, outPath) {
  await runFfmpeg(['-y', '-ss', '0.5', '-i', videoPath, '-frames:v', '1', outPath]);
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

  const cartoon = channel.visualStyle === 'cartoonAnimation' && scenes.length > 0;
  const stockFootage = channel.visualStyle === 'stockFootage' && scenes.length > 0;
  const shotCount = (cartoon || stockFootage) ? scenes.length : Math.max(3, Math.round(durationSeconds / 7));
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

    if (cartoon) {
      try {
        const firstFrame = await cartoonClip(scenes[i] || '', clipPath, workDir, i, w, h, fps, durations[i], shotSeed);
        if (i === 0 && firstFrame) {
          await writeFile(path.join(workDir, 'scene-0.png'), firstFrame);
        }
        clipPaths.push(clipPath);
        continue;
      } catch (err) {
        // Full stack trace on stderr - previous versions logged only
        // err.message, which turned out to be the empty string for the
        // silent PNG/ffmpeg failure that caused two broken shorts to
        // publish before we caught it. Any future silent failure now
        // shows up in the CI step's output with a real error location.
        console.error(`[background] scene ${i} cartoon render FAILED, falling back to gradient. Full error:`);
        console.error(err && err.stack ? err.stack : err);
      }
    }

    if (stockFootage) {
      try {
        const sourcePath = path.join(workDir, `stock-source-${i}.mp4`);
        const buffer = await findStockFootageClip(scenes[i], { width: w, height: h });
        await writeFile(sourcePath, buffer);
        await footageClip(sourcePath, clipPath, w, h, fps, durations[i]);
        if (i === 0) {
          await extractFrame(clipPath, path.join(workDir, 'scene-0.png'));
        }
        clipPaths.push(clipPath);
        continue;
      } catch (err) {
        console.warn(`[background] scene ${i} stock footage failed, using gradient fallback:`, err.message);
      }
    }

    const framePath = path.join(workDir, `scene-${i}.png`);
    await writeFile(framePath, renderGradientFrame(w, h, channel.brandColorA, channel.brandColorB, shotSeed));

    const focus = FOCUS_POINTS[shotSeed % FOCUS_POINTS.length];
    await zoomClip(framePath, clipPath, w, h, fps, durations[i], focus);
    clipPaths.push(clipPath);
  }

  return concatClips(clipPaths, workDir);
}

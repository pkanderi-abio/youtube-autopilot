// Step 6 - render. Each scene becomes its own video segment of exactly the
// scene's narration length:
//   - AI still  -> animated with a camera move (zoom in/out, pan) that
//                  varies scene to scene, so nothing ever sits static
//                  (a slow single background used to read as a frozen video)
//   - AI clip   -> used as-is (cover-cropped), topped up with the still if
//                  the clip is shorter than the narration
// Segments are concatenated with hard cuts (the norm for Shorts), muxed
// with the voice track, and optionally get burned-in captions.
import path from 'path';
import { writeFile } from 'fs/promises';
import { ffmpeg } from '../lib/ffmpeg.js';
import { frameSize } from './5-visuals.js';

const FPS = 30;
const PRESCALE = 1.5; // render zoompan on a larger canvas to avoid sub-pixel jitter

const MOVES = [
  // [zoom expr, x expr, y expr]  - `p` = progress 0..1 is substituted below
  ['1+0.18*p', 'iw/2-(iw/zoom/2)', 'ih/2-(ih/zoom/2)'], // slow push-in
  ['1.18-0.18*p', 'iw/2-(iw/zoom/2)', 'ih/2-(ih/zoom/2)'], // pull-out
  ['1.15', '(iw-iw/zoom)*p', 'ih/2-(ih/zoom/2)'], // pan left -> right
  ['1.15', '(iw-iw/zoom)*(1-p)', 'ih/2-(ih/zoom/2)'], // pan right -> left
  ['1.15', 'iw/2-(iw/zoom/2)', '(ih-ih/zoom)*(1-p)'], // tilt up
  ['1+0.15*p', '(iw-iw/zoom)*0.3', '(ih-ih/zoom)*0.35'] // push-in off-centre
];

function coverScale(w, h) {
  return `scale=${w}:${h}:force_original_aspect_ratio=increase,crop=${w}:${h},setsar=1`;
}

async function stillSegment(image, seconds, index, { width, height }, out) {
  const frames = Math.max(1, Math.round(seconds * FPS));
  const [z, x, y] = MOVES[index % MOVES.length].map((e) => e.replaceAll('p', `(on/${frames})`));
  const bw = Math.round(width * PRESCALE / 2) * 2;
  const bh = Math.round(height * PRESCALE / 2) * 2;
  await ffmpeg([
    // single input frame: zoompan emits `d` output frames from it
    '-i', image,
    '-vf', `${coverScale(bw, bh)},zoompan=z='${z}':x='${x}':y='${y}':d=${frames}:s=${width}x${height}:fps=${FPS},format=yuv420p`,
    '-frames:v', String(frames), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-an', out
  ]);
}

async function clipSegment(clip, seconds, { width, height }, out) {
  await ffmpeg([
    '-i', clip.path, '-t', String(Math.min(seconds, clip.duration)),
    '-vf', `${coverScale(width, height)},fps=${FPS},format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-an', out
  ]);
}

// ---- captions (ASS, burned with libass from ffmpeg-static) ----------------
function assTime(t) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = (t % 60).toFixed(2).padStart(5, '0');
  return `${h}:${String(m).padStart(2, '0')}:${s}`;
}

function buildAss(scenes, { width, height }, vertical) {
  const size = vertical ? 88 : 64;
  const marginV = vertical ? Math.round(height * 0.28) : 70;
  const lines = [];
  let t = 0;
  for (const scene of scenes) {
    const text = scene.caption ?? scene.narration;
    const speak = Math.max(0.5, scene.duration - (scene.caption != null ? 0 : 0.3));
    if (text) {
      const words = text.split(/\s+/).filter(Boolean);
      const chunks = [];
      for (let i = 0; i < words.length; i += vertical ? 3 : 6) chunks.push(words.slice(i, i + (vertical ? 3 : 6)).join(' '));
      const totalChars = chunks.reduce((n, c) => n + c.length, 0) || 1;
      let ct = t;
      for (const c of chunks) {
        const d = speak * (c.length / totalChars);
        lines.push(`Dialogue: 0,${assTime(ct)},${assTime(ct + d)},Cap,,0,0,0,,${c.replace(/[{}\\]/g, '')}`);
        ct += d;
      }
    }
    t += scene.duration;
  }
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Cap,DejaVu Sans,${size},&H00FFFFFF,&H00FFFFFF,&H00000000,&H64000000,1,0,0,0,100,100,0,0,1,6,2,2,60,60,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${lines.join('\n')}
`;
}

export async function renderVideo(channel, script, audioPath, workDir) {
  const size = frameSize(channel.format);
  const segments = [];

  for (const [i, scene] of script.scenes.entries()) {
    const base = path.join(workDir, `seg-${String(i).padStart(3, '0')}`);
    if (scene.clip) {
      await clipSegment(scene.clip, scene.duration, size, `${base}-a.mp4`);
      segments.push(`${base}-a.mp4`);
      const rest = scene.duration - Math.min(scene.duration, scene.clip.duration);
      if (rest > 0.4) {
        await stillSegment(scene.image, rest, i + 1, size, `${base}-b.mp4`);
        segments.push(`${base}-b.mp4`);
      }
    } else {
      await stillSegment(scene.image, scene.duration, i, size, `${base}.mp4`);
      segments.push(`${base}.mp4`);
    }
  }

  const list = path.join(workDir, 'segments.txt');
  await writeFile(list, segments.map((s) => `file '${s}'`).join('\n'));
  const silent = path.join(workDir, 'visuals.mp4');
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', silent]);

  const out = path.join(workDir, 'final.mp4');
  const args = ['-i', silent, '-i', audioPath, '-map', '0:v', '-map', '1:a'];
  if (channel.captions) {
    const assPath = path.join(workDir, 'captions.ass');
    await writeFile(assPath, buildAss(script.scenes, size, channel.format === 'short'));
    args.push('-vf', `ass=${assPath}`, '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20');
  } else {
    args.push('-c:v', 'copy');
  }
  args.push('-c:a', 'aac', '-b:a', '160k', '-shortest', '-movflags', '+faststart', out);
  await ffmpeg(args);
  return out;
}

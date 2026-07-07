// Step 5 - mux the generated background with the voiceover, burning
// captionLines in as timed on-screen text (evenly spaced across the
// audio's actual duration - no word-level alignment, but reads fine
// for short-form punchy lines).
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import ffprobePath from 'ffprobe-static';
import path from 'path';
import { writeFile } from 'fs/promises';

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath.path);

function getDuration(file) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, data) => err ? reject(err) : resolve(data.format.duration));
  });
}

function srtTimestamp(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const pad = (n, len) => String(n).padStart(len, '0');
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  const s = Math.floor((ms % 60000) / 1000);
  return `${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)},${pad(ms % 1000, 3)}`;
}

function buildSrt(captionLines, duration) {
  const perLine = duration / captionLines.length;
  return captionLines.map((line, i) => {
    const start = srtTimestamp(i * perLine);
    const end = srtTimestamp((i + 1) * perLine);
    const text = line.replace(/[{}]/g, '');
    return `${i + 1}\n${start} --> ${end}\n${text}\n`;
  }).join('\n');
}

export async function assembleVideo({ backgroundPath, audioPath, captionLines, workDir }) {
  const outPath = path.join(workDir, 'final.mp4');
  const duration = await getDuration(audioPath);

  const outputOptions = ['-c:v', 'libx264', '-c:a', 'aac', '-shortest', '-pix_fmt', 'yuv420p'];

  if (captionLines && captionLines.length) {
    const srtPath = path.join(workDir, 'captions.srt');
    await writeFile(srtPath, buildSrt(captionLines, duration), 'utf8');

    // libass renders a style-less SRT against its default 384x288 canvas and
    // scales to the real frame size, so these values are canvas units, not
    // output pixels - they stay constant across both channel formats.
    const escapedSrtPath = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
    const style = 'FontName=sans-serif,Bold=1,FontSize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BorderStyle=1,Outline=2,Shadow=0,Alignment=2,MarginV=30';
    outputOptions.push('-vf', `subtitles=filename='${escapedSrtPath}':force_style='${style}'`);
  }

  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(backgroundPath)
      .input(audioPath)
      .outputOptions(outputOptions)
      .save(outPath)
      .on('end', resolve)
      .on('error', reject);
  });

  return outPath;
}

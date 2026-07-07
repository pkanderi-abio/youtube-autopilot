// Step 5 - mux the generated background with the voiceover, burning
// captionLines in as timed on-screen text (evenly spaced across the
// audio's actual duration - no word-level alignment, but reads fine
// for short-form punchy lines).
import ffmpeg from 'fluent-ffmpeg';
import ffmpegPath from 'ffmpeg-static';
import ffprobePath from 'ffprobe-static';
import path from 'path';

ffmpeg.setFfmpegPath(ffmpegPath);
ffmpeg.setFfprobePath(ffprobePath.path);

function getDuration(file) {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, data) => {
      if (err) return reject(err);
      resolve(data.format.duration);
    });
  });
}

function escapeDrawtext(s) {
  return s.replace(/\\/g, '\\\\').replace(/:/g, '\\:').replace(/'/g, "\u2019");
}

export async function assembleVideo({ backgroundPath, audioPath, captionLines, workDir }) {
  const duration = await getDuration(audioPath);
  const perLine = duration / captionLines.length;

  const drawtextFilters = captionLines.map((line, i) => {
    const start = (i * perLine).toFixed(2);
    const end = ((i + 1) * perLine).toFixed(2);
    const text = escapeDrawtext(line);
    return `drawtext=text='${text}':fontcolor=white:fontsize=54:box=1:boxcolor=black@0.45:boxborderw=24:x=(w-text_w)/2:y=h-h/3.2:enable='between(t,${start},${end})'`;
  }).join(',');

  const outPath = path.join(workDir, 'final.mp4');

  await new Promise((resolve, reject) => {
    ffmpeg()
      .input(backgroundPath)
      .input(audioPath)
      .outputOptions([
        '-vf', drawtextFilters,
        '-c:v', 'libx264',
        '-c:a', 'aac',
        '-shortest',
        '-pix_fmt', 'yuv420p'
      ])
      .save(outPath)
      .on('end', resolve)
      .on('error', reject);
  });

  return outPath;
}

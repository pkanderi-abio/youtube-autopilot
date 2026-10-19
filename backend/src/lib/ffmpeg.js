// Tiny promise wrappers around the bundled ffmpeg/ffprobe binaries.
// ffmpeg-static's build ships libass + freetype, so subtitle burning
// works without any apt-get step in CI.
import { spawn } from 'child_process';
import ffmpegStatic from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';

export const FFMPEG = process.env.FFMPEG_PATH || ffmpegStatic;
export const FFPROBE = process.env.FFPROBE_PATH || ffprobeStatic.path;

function run(bin, args, { quiet = true } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, args);
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (d) => { stdout += d; });
    p.stderr.on('data', (d) => { stderr += d; if (!quiet) process.stderr.write(d); });
    p.on('error', reject);
    p.on('close', (code) => code === 0
      ? resolve(stdout)
      : reject(new Error(`${bin.split('/').pop()} exited ${code}: ${stderr.slice(-1500)}`)));
  });
}

export const ffmpeg = (args) => run(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args]);

export async function probeDuration(file) {
  const out = await run(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  const d = Number(out.trim());
  if (!Number.isFinite(d) || d <= 0) throw new Error(`could not read duration of ${file}`);
  return d;
}

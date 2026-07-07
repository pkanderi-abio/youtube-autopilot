// Step 4 - a procedurally generated animated background.
// Uses ffmpeg's built-in moving test source so the output is dynamic
// without requiring canvas or native builds.
import path from 'path';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'child_process';

export async function generateBackground(channel, durationSeconds, workDir) {
  const w = channel.format === 'short' ? 1080 : 1920;
  const h = channel.format === 'short' ? 1920 : 1080;
  const outPath = path.join(workDir, 'bg-video.mp4');
  const fps = 25;

  const args = [
    '-y',
    '-f', 'lavfi',
    '-i', `testsrc2=duration=${durationSeconds}:size=${w}x${h}:rate=${fps}`,
    '-vf', 'format=yuv420p',
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

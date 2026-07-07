// Step 4 - a procedurally generated, slowly-shifting gradient background
// sized for the channel's format. This is an honest substitute for real
// b-roll/AI video generation: it's free, deterministic, and looks
// intentional rather than trying to fake stock footage. Swap this file
// for a Pexels/stock-footage fetch or an AI video API later if you want
// richer visuals - everything downstream just expects a video file.
import { createCanvas } from 'canvas';
import { writeFile } from 'fs/promises';
import path from 'path';
import ffmpegPath from 'ffmpeg-static';
import { spawn } from 'child_process';

export async function generateBackground(channel, durationSeconds, workDir) {
  const w = channel.format === 'short' ? 1080 : 1920;
  const h = channel.format === 'short' ? 1920 : 1080;

  const framePath = path.join(workDir, 'bg-frame.png');
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, channel.brandColorA);
  grad.addColorStop(1, channel.brandColorB);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);
  await writeFile(framePath, canvas.toBuffer('image/png'));

  // Animate the still frame with a slow zoom + hue drift so it isn't a
  // static slide - zoompan for motion, hue for color drift over time.
  const outPath = path.join(workDir, 'bg-video.mp4');
  const args = [
    '-y', '-loop', '1', '-i', framePath,
    '-t', String(durationSeconds),
    '-vf', `zoompan=z='min(zoom+0.0006,1.15)':d=${Math.ceil(durationSeconds * 25)}:s=${w}x${h}:fps=25,hue=h=sin(2*PI*t/${durationSeconds})*20`,
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', outPath
  ];

  await new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args);
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error('ffmpeg background failed: ' + stderr)));
  });

  return outPath;
}

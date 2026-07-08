// Thin wrapper around a self-hosted stable-diffusion.cpp CLI binary -
// no paid API, fully open-source, matching this repo's spawn-a-binary
// pattern already used for ffmpeg in 4-generate-background.js.
// SD_CPP_BIN / SD_CPP_MODEL point at the binary + GGUF model (see
// .github/workflows/pipeline.yml for how CI downloads and caches them).
import { spawn } from 'child_process';
import { readFile, unlink } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

const SD_CPP_BIN = process.env.SD_CPP_BIN || 'sd-cli';
const SD_CPP_MODEL = process.env.SD_CPP_MODEL;

// Applied to every scene prompt so independently-generated images share
// a consistent look. A real (not hypothetical) comparison of raw
// generated scenes from one video showed a mix: some crisp flat-vector
// results, others noticeably soft/painterly, plus two with garbled
// pseudo-text baked into the image - a known SD1.5 weakness (it can't
// render legible text and often hallucinates text-like shapes even
// when told not to in the positive prompt). "Don't do X" is a weak
// signal in a positive prompt; --negative-prompt is what diffusion
// models actually respect for steering away from unwanted qualities.
export const SCENE_STYLE_SUFFIX = ', flat 2D children\'s book illustration, bright cheerful colors, '
  + 'simple rounded friendly shapes, thick clean bold outlines, crisp sharp vector art, '
  + 'high contrast, single clear focal subject, simple plain background';
export const SCENE_NEGATIVE_PROMPT = 'text, letters, words, writing, watermark, signature, '
  + 'blurry, soft focus, out of focus, hazy, low contrast, washed out, painterly, '
  + 'photorealistic, realistic, 3d render, noise, grain';

export async function generateSceneImage(prompt, { width, height }) {
  if (!SD_CPP_MODEL) {
    throw new Error('Missing SD_CPP_MODEL (path to a stable-diffusion.cpp GGUF model)');
  }

  // SD1.5 is only trained at ~512px-scale resolutions - generating
  // directly at the video frame's full size (1920x1080+) would produce
  // the distorted/duplicated-subject artifacts SD1.5 is known for well
  // past its native resolution, and take dramatically longer. Generate
  // at a safe native size matching the frame's orientation and let the
  // existing Ken Burns zoompan step (4-generate-background.js) upscale
  // to the real frame - it already crops/scales arbitrary source sizes.
  const isPortrait = height > width;
  const sdWidth = isPortrait ? 512 : 768;
  const sdHeight = isPortrait ? 768 : 512;

  const outPath = path.join(tmpdir(), `sd-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  const args = [
    '-m', SD_CPP_MODEL,
    '-p', prompt + SCENE_STYLE_SUFFIX,
    '-n', SCENE_NEGATIVE_PROMPT,
    '-o', outPath,
    '-W', String(sdWidth),
    '-H', String(sdHeight),
    '--steps', '20',
    '--cfg-scale', '7.0',
    '--backend', 'cpu'
  ];

  await new Promise((resolve, reject) => {
    const p = spawn(SD_CPP_BIN, args);
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error('stable-diffusion.cpp failed: ' + stderr)));
  });

  const buffer = await readFile(outPath);
  await unlink(outPath).catch(() => {});
  return buffer;
}

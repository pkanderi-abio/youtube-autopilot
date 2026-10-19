// Step 5 - AI visuals for every scene: one generated still per scene (in
// the channel's fixed `artStyle`, with the script's visualBible repeated so
// characters stay consistent), plus optional true AI motion clips for the
// hook scene(s) when a free video provider is available.
import path from 'path';
import { writeFile } from 'fs/promises';
import { generateSceneImage } from '../lib/images.js';
import { generateAiClip, aiClipsAvailable } from '../lib/aiClips.js';

const CONCURRENCY = Number(process.env.IMAGE_CONCURRENCY || 3);

export function frameSize(format) {
  return format === 'short' ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 };
}

function buildPrompt(channel, script, scene) {
  return [
    scene.visual,
    script.visualBible ? `Consistent details: ${script.visualBible}` : '',
    `Style: ${channel.artStyle || 'cinematic, highly detailed, dramatic lighting'}`,
    'No text, no letters, no watermark, no logo.'
  ].filter(Boolean).join('. ');
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }));
  return results;
}

export async function generateVisuals(channel, script, workDir) {
  const vertical = channel.format === 'short';
  // Generation size: 9:16 / 16:9 for models that honour it (FLUX-2, Pollinations);
  // flux-1-schnell always returns 1024x1024 and step 6 cover-crops it.
  const gen = vertical ? { width: 768, height: 1344 } : { width: 1344, height: 768 };
  const baseSeed = Math.floor(Math.random() * 1e6);
  const providers = {};

  await mapLimit(script.scenes, CONCURRENCY, async (scene, i) => {
    scene.prompt = buildPrompt(channel, script, scene);
    const { buffer, provider } = await generateSceneImage(scene.prompt, { ...gen, seed: baseSeed + i, model: channel.imageModel });
    scene.image = path.join(workDir, `scene-${String(i).padStart(3, '0')}.jpg`);
    await writeFile(scene.image, buffer);
    providers[provider] = (providers[provider] || 0) + 1;
  });

  let clips = 0;
  const clipScenes = channel.aiClips?.scenes ?? [0];
  if (channel.aiClips?.enabled && aiClipsAvailable()) {
    for (const i of clipScenes) {
      const scene = script.scenes[i];
      if (!scene) continue;
      const clip = await generateAiClip(`${scene.prompt}. Smooth cinematic camera motion, subtle natural movement.`,
        path.join(workDir, `clip-${i}.mp4`), { aspectRatio: vertical ? '9:16' : '16:9', duration: Math.min(8, Math.ceil(scene.duration || 5)) });
      if (clip) { scene.clip = clip; clips++; }
    }
  }

  return { providers, clips };
}

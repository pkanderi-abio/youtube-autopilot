// Step 5 - AI visuals for every scene: one generated still per scene (in
// the channel's fixed `artStyle`, with the script's visualBible repeated so
// characters stay consistent), plus optional true AI motion clips for the
// hook scene(s) when a free video provider is available.
import path from 'path';
import { writeFile } from 'fs/promises';
import { generateSceneImage } from '../lib/images.js';
import { generateAiClip, aiClipsAvailable } from '../lib/aiClips.js';
import { generateKaggleClips, kaggleAvailable } from '../lib/kaggleClips.js';

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

  const clips = await addAiClips(channel, script, workDir, vertical);
  return { providers, clips };
}

// Which scenes get real AI motion: "all" (capped at maxClips, spread evenly
// and always including the hook) or an explicit list of scene indexes.
function pickClipScenes(aiClips, count) {
  if (Array.isArray(aiClips.scenes)) return aiClips.scenes.filter((i) => i < count);
  const max = Math.min(count, aiClips.maxClips ?? count);
  if (max >= count) return [...Array(count).keys()];
  return [...new Set(Array.from({ length: max }, (_, k) => Math.round((k * (count - 1)) / Math.max(1, max - 1))))];
}

const MOTION_HINT = 'Natural, smooth motion of the subject with a slow cinematic camera move. Realistic physics, no morphing.';

async function addAiClips(channel, script, workDir, vertical) {
  const cfg = channel.aiClips;
  if (!cfg?.enabled) return 0;
  const indexes = pickClipScenes(cfg, script.scenes.length);
  const provider = cfg.provider && cfg.provider !== 'auto'
    ? cfg.provider
    : kaggleAvailable() ? 'kaggle' : aiClipsAvailable() ? 'pollinations' : null;
  if (!provider || !indexes.length) return 0;

  if (provider === 'kaggle') {
    // 8n+1 frames at 24fps on a 32-px grid; LTX-Video's sweet spot on a T4
    const size = vertical ? { width: 512, height: 768 } : { width: 768, height: 512 };
    const clips = await generateKaggleClips(
      indexes.map((index) => ({ index, image: script.scenes[index].image, prompt: `${script.scenes[index].prompt} ${MOTION_HINT}` })),
      workDir, { name: `${channel.id}-${channel.format}`, ...size });
    for (const [index, clip] of clips) script.scenes[index].clip = clip;
    return clips.size;
  }

  let n = 0;
  for (const i of indexes) {
    if (!aiClipsAvailable()) break;
    const scene = script.scenes[i];
    const clip = await generateAiClip(`${scene.prompt}. ${MOTION_HINT}`,
      path.join(workDir, `clip-${i}.mp4`), { aspectRatio: vertical ? '9:16' : '16:9', duration: Math.min(8, Math.ceil(scene.duration || 5)) });
    if (clip) { scene.clip = clip; n++; }
  }
  return n;
}

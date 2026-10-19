// Optional true AI motion clips (text-to-video) for the most important
// shots - by default just the opening hook, where motion matters most for
// retention. Free AI video is scarce and rate-limited, so this is strictly
// best-effort: any failure returns null and that scene falls back to the
// AI still + camera-motion treatment, which is always available.
//
// Provider: Pollinations.ai video endpoint. Needs POLLINATIONS_API_KEY
// (free account at https://enter.pollinations.ai; video draws on the
// account's free/earned "pollen" balance). Without a key this is skipped.
import { writeFile } from 'fs/promises';
import { probeDuration } from './ffmpeg.js';
import { MOCK } from './llm.js';

const KEY = process.env.POLLINATIONS_API_KEY;
const MODEL = process.env.POLLINATIONS_VIDEO_MODEL; // unset = provider default

export function aiClipsAvailable() {
  return Boolean(KEY) && !MOCK && process.env.AI_CLIPS !== '0';
}

export async function generateAiClip(prompt, outPath, { aspectRatio = '9:16', duration = 5 } = {}) {
  if (!aiClipsAvailable()) return null;
  const params = new URLSearchParams({ aspectRatio, duration: String(duration) });
  if (MODEL) params.set('model', MODEL);
  const url = `https://gen.pollinations.ai/video/${encodeURIComponent(prompt.slice(0, 1200))}?${params}`;
  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${KEY}` },
      signal: AbortSignal.timeout(300_000)
    });
    const type = res.headers.get('content-type') || '';
    if (!res.ok || !type.startsWith('video/')) {
      throw new Error(`${res.status} ${type} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    }
    await writeFile(outPath, Buffer.from(await res.arrayBuffer()));
    const d = await probeDuration(outPath);
    if (d < 1) throw new Error(`clip too short (${d}s)`);
    return { path: outPath, duration: d };
  } catch (error) {
    console.warn(`[ai-clip] skipped (falling back to still + motion): ${error.message}`);
    return null;
  }
}

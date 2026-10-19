// AI still images for every scene. Provider chain, all free:
//   1. Cloudflare Workers AI FLUX (default flux-1-schnell, ~58 neurons/image)
//   2. Pollinations.ai FLUX (needs POLLINATIONS_API_KEY - keyless calls get 401)
// If every provider fails the run aborts - we never ship a video of
// blank/placeholder frames (the old "silent gradient fallback" incident).
import sharp from 'sharp';
import { generateImage as cfImage, cloudflareConfigured, QuotaExceededError } from './cloudflare.js';
import { MOCK } from './llm.js';

const CF_MODEL = process.env.CF_IMAGE_MODEL || '@cf/black-forest-labs/flux-1-schnell';
const POLLINATIONS_KEY = process.env.POLLINATIONS_API_KEY;
const POLLINATIONS_MODEL = process.env.POLLINATIONS_IMAGE_MODEL || 'flux';

let cloudflareExhausted = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function pollinationsImage(prompt, { width, height, seed }) {
  const params = new URLSearchParams({
    model: POLLINATIONS_MODEL, width: String(width), height: String(height),
    seed: String(seed ?? Math.floor(Math.random() * 1e9)), nologo: 'true', enhance: 'false'
  });
  const url = `https://gen.pollinations.ai/image/${encodeURIComponent(prompt.slice(0, 1500))}?${params}`;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        headers: POLLINATIONS_KEY ? { Authorization: `Bearer ${POLLINATIONS_KEY}` } : {},
        signal: AbortSignal.timeout(180_000)
      });
      const type = res.headers.get('content-type') || '';
      if (res.ok && type.startsWith('image/')) return Buffer.from(await res.arrayBuffer());
      throw new Error(`pollinations ${res.status} ${type} ${(await res.text().catch(() => '')).slice(0, 200)}`);
    } catch (error) {
      lastError = error;
      await sleep(5000 * (attempt + 1));
    }
  }
  throw lastError;
}

async function mockImage(prompt, { width, height, seed = 1 }) {
  const hue = (seed * 47) % 360;
  const label = prompt.slice(0, 60).replace(/[<&>]/g, '');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="hsl(${hue},70%,45%)"/><stop offset="1" stop-color="hsl(${(hue + 120) % 360},70%,25%)"/>
    </linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <circle cx="${width * 0.3}" cy="${height * 0.35}" r="${Math.min(width, height) * 0.15}" fill="rgba(255,255,255,0.35)"/>
    <text x="50%" y="55%" font-family="DejaVu Sans, sans-serif" font-size="${Math.round(width / 26)}" fill="white" text-anchor="middle">${label}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 90 }).toBuffer();
}

// Rejects near-uniform frames (black/blank/safety-filtered placeholders).
async function looksBlank(buffer) {
  const { channels } = await sharp(buffer).stats();
  const avgStdev = channels.slice(0, 3).reduce((s, c) => s + c.stdev, 0) / 3;
  return avgStdev < 6;
}

export async function generateSceneImage(prompt, { width = 1024, height = 1024, seed, model } = {}) {
  if (MOCK) return { buffer: await mockImage(prompt, { width, height, seed }), provider: 'mock' };

  const attempts = [];
  if (cloudflareConfigured() && !cloudflareExhausted) {
    attempts.push(['cloudflare', () => cfImage(model || CF_MODEL, prompt, { width, height, seed })]);
  }
  // Pollinations now rejects keyless requests (401), so only try it with a key.
  if (POLLINATIONS_KEY) attempts.push(['pollinations', () => pollinationsImage(prompt, { width, height, seed })]);
  if (!attempts.length) throw new Error('[images] no image provider configured (set CF_ACCOUNT_ID/CF_API_TOKEN)');

  const errors = [];
  for (const [name, fn] of attempts) {
    try {
      const buf = await fn();
      if (await looksBlank(buf)) throw new Error('image was blank/uniform (likely safety-filtered)');
      return { buffer: buf, provider: name };
    } catch (error) {
      if (error instanceof QuotaExceededError) {
        cloudflareExhausted = true;
        console.warn('[images] Cloudflare free daily allocation used up - switching to Pollinations for the rest of this run');
      }
      errors.push(`${name}: ${error.message}`);
    }
  }
  throw new Error(`[images] all providers failed for "${prompt.slice(0, 80)}":\n${errors.join('\n')}`);
}

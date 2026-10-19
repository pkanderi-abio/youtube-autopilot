// Cloudflare Workers AI - the single free provider behind script writing,
// image generation and backup TTS. The free plan includes 10,000 neurons
// per day (resets 00:00 UTC), no credit card needed:
//   https://developers.cloudflare.com/workers-ai/platform/pricing/
//
// Secrets: CF_ACCOUNT_ID + CF_API_TOKEN (a token with "Workers AI: Read"
// and "Workers AI: Edit" permissions).
//
// Every call records a rough neuron estimate so each run logs what it
// spent - the free allowance is the real constraint on how many AI images
// a day of publishing can use (see BUDGET in README).

const ACCOUNT_ID = process.env.CF_ACCOUNT_ID;
const API_TOKEN = process.env.CF_API_TOKEN;
const BASE = () => `https://api.cloudflare.com/client/v4/accounts/${ACCOUNT_ID}/ai`;

export const usage = { neurons: 0, calls: 0 };

export class QuotaExceededError extends Error {}

export function cloudflareConfigured() {
  return Boolean(ACCOUNT_ID && API_TOKEN);
}

function assertConfigured() {
  if (!cloudflareConfigured()) {
    throw new Error('CF_ACCOUNT_ID and CF_API_TOKEN must be set (free Cloudflare Workers AI account)');
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(url, init, label) {
  assertConfigured();
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        headers: { Authorization: `Bearer ${API_TOKEN}`, ...(init.headers || {}) },
        signal: AbortSignal.timeout(120_000)
      });
      usage.calls++;
      if (res.ok) return res;
      const body = await res.text().catch(() => '');
      // 4006 = "you have used up your daily free allocation of 10,000 neurons"
      if (res.status === 429 && /4006|daily free allocation|neurons/i.test(body)) {
        throw new QuotaExceededError(`[cloudflare] ${label}: daily free neuron allocation used up`);
      }
      const err = new Error(`[cloudflare] ${label} failed: ${res.status} ${body.slice(0, 300)}`);
      err.retryable = res.status === 429 || res.status >= 500;
      throw err;
    } catch (error) {
      lastError = error;
      if (error instanceof QuotaExceededError) throw error;
      const retryable = error.retryable ?? (error.name === 'TimeoutError' || error.name === 'TypeError');
      if (!retryable || attempt === 2) throw error;
      console.warn(`${error.message} - retrying (${attempt + 1}/3)`);
      await sleep(4000 * (attempt + 1));
    }
  }
  throw lastError;
}

// ---- Text (OpenAI-compatible chat completions endpoint) -------------------
// Output-token neuron rates for the models we default to (input is ~8x cheaper).
const OUTPUT_NEURONS_PER_TOKEN = {
  '@cf/meta/llama-3.3-70b-instruct-fp8-fast': 0.205,
  '@cf/meta/llama-4-scout-17b-16e-instruct': 0.077,
  '@cf/openai/gpt-oss-120b': 0.068,
  '@cf/google/gemma-4-26b-a4b-it': 0.027
};

export async function chat(model, messages, { maxTokens = 1500, json = true, temperature = 0.8 } = {}) {
  const res = await request(`${BASE()}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      messages,
      max_tokens: maxTokens,
      temperature,
      ...(json ? { response_format: { type: 'json_object' } } : {})
    })
  }, `chat ${model}`);
  const data = await res.json();
  const content = data.choices?.[0]?.message?.content;
  const u = data.usage || {};
  usage.neurons += (u.completion_tokens || 0) * (OUTPUT_NEURONS_PER_TOKEN[model] ?? 0.2)
    + (u.prompt_tokens || 0) * 0.027;
  if (content == null || content === '') throw new Error(`[cloudflare] ${model} returned no content`);
  return typeof content === 'string' ? content : JSON.stringify(content);
}

// ---- Images ----------------------------------------------------------------
// flux-1-schnell: JSON body, fixed 1024x1024, ~58 neurons at 4 steps.
// flux-2-klein-*: multipart body, any size 256-1920, ~26 neurons / 512px tile.
function tiles(w, h) {
  return Math.ceil(w / 512) * Math.ceil(h / 512);
}

export async function generateImage(model, prompt, { width = 1024, height = 1024, seed, steps = 4 } = {}) {
  const url = `${BASE()}/run/${model}`;
  let res;
  if (/flux-2/.test(model)) {
    const form = new FormData();
    form.append('prompt', prompt);
    form.append('width', String(width));
    form.append('height', String(height));
    if (seed != null) form.append('seed', String(seed));
    res = await request(url, { method: 'POST', body: form }, `image ${model}`);
    usage.neurons += tiles(width, height) * 26;
  } else {
    res = await request(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt, steps: Math.min(8, steps), ...(seed != null ? { seed } : {}) })
    }, `image ${model}`);
    usage.neurons += 4 * 4.8 + Math.min(8, steps) * 9.6;
  }
  return decodeImage(res);
}

async function decodeImage(res) {
  const type = res.headers.get('content-type') || '';
  if (type.startsWith('image/')) return Buffer.from(await res.arrayBuffer());
  const data = await res.json();
  const b64 = data.result?.image || data.image;
  if (!b64) throw new Error('[cloudflare] image response had no image field');
  return Buffer.from(b64, 'base64');
}

// ---- Backup TTS (MeloTTS, ~19 neurons per audio minute) -------------------
export async function melotts(text, lang = 'en') {
  const res = await request(`${BASE()}/run/@cf/myshell-ai/melotts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ prompt: text, lang })
  }, 'tts melotts');
  usage.neurons += 20;
  const type = res.headers.get('content-type') || '';
  if (type.startsWith('audio/')) return Buffer.from(await res.arrayBuffer());
  const data = await res.json();
  const b64 = data.result?.audio || data.audio;
  if (!b64) throw new Error('[cloudflare] melotts response had no audio field');
  return Buffer.from(b64, 'base64');
}

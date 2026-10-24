// JSON-in, JSON-out text generation on Cloudflare Workers AI (free tier).
//
// Load-bearing decision kept from the old pipeline: NO template fallback.
// A templated "{topic} in {niche}" video once got published when the LLM
// was down; failing the run (and skipping that publish slot) is better.
//
// MOCK_AI=1 short-circuits to the caller-supplied `mock()` so the whole
// pipeline can be exercised offline (see `npm run mock`).
import { chat } from './cloudflare.js';

export const MOCK = process.env.MOCK_AI === '1';

// LLM_PROVIDER=ollama routes script/SEO text generation to a local Ollama
// server instead of Cloudflare - free, unlimited, and (more importantly
// for this pipeline) leaves the entire Cloudflare 10,000-neuron/day budget
// for FLUX images, which Ollama can't do. Images stay on Cloudflare either
// way; this only affects completeJSON.
const TEXT_PROVIDER = process.env.LLM_PROVIDER || 'cloudflare';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';

// Llama 3.3 70B is primary despite costing ~3x the neurons of Llama 4
// Scout: confirmed directly across 7 real short-form runs, Scout missed
// the 90-word narration floor on 4 of them (77-84 words vs. target
// 120-150), the same "fast/cheap model undershoots word-count targets"
// pattern seen with every small model tried elsewhere in this project.
// Actual daily usage (~1,300 of 10,000 free neurons per video, mostly
// from FLUX images) has far more headroom than the cost difference needs.
const PRIMARY = process.env.CF_TEXT_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';
const FALLBACK = process.env.CF_TEXT_FALLBACK_MODEL || '@cf/meta/llama-4-scout-17b-16e-instruct';

const DEFAULT_SYSTEM = 'You are a careful YouTube writer. Always reply with a single valid JSON object and nothing else.';

// Models occasionally wrap JSON in ``` fences, add prose around it, or put
// raw newlines/tabs inside string values. Repair the common cases.
export function parseJsonLoose(text) {
  let t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const start = t.indexOf('{');
  const end = t.lastIndexOf('}');
  if (start >= 0 && end > start) t = t.slice(start, end + 1);
  try {
    return JSON.parse(t);
  } catch {
    // escape raw control chars that appear inside string literals
    let out = '';
    let inString = false;
    let escaped = false;
    for (const ch of t) {
      if (inString) {
        if (escaped) { escaped = false; out += ch; continue; }
        if (ch === '\\') { escaped = true; out += ch; continue; }
        if (ch === '"') { inString = false; out += ch; continue; }
        if (ch === '\n') { out += '\\n'; continue; }
        if (ch === '\r') continue;
        if (ch === '\t') { out += '\\t'; continue; }
        out += ch;
      } else {
        if (ch === '"') inString = true;
        out += ch;
      }
    }
    return JSON.parse(out.replace(/,\s*([}\]])/g, '$1'));
  }
}

async function chatOllama(messages, { maxTokens, temperature }) {
  const res = await fetch(`${OLLAMA_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      messages,
      stream: false,
      format: 'json',
      // Reasoning/"thinking" models (confirmed directly with qwen3.5 on
      // the main branch) emit a separate internal `thinking` field before
      // the real response, but num_predict caps both combined - no
      // headroom here means the thinking phase can eat the whole budget
      // and leave nothing for the actual JSON answer. Same fix as the
      // Gemini/Ollama headroom applied in the old pipeline's llm.js.
      options: { temperature, num_predict: Math.min(Math.max(maxTokens * 4, 2048), 8192) }
    })
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Ollama request failed: ${res.status} ${res.statusText} - ${body.slice(0, 300)}`);
  }
  const data = await res.json();
  const text = data.message?.content;
  if (!text && data.message?.thinking) {
    throw new Error(`Ollama model spent its entire output budget on <thinking> with nothing left for the actual response (thinking: ${data.message.thinking.length} chars)`);
  }
  if (!text) throw new Error('Ollama returned no content');
  return text;
}

export async function completeJSON(prompt, { system = DEFAULT_SYSTEM, maxTokens = 1500, temperature = 0.8, mock } = {}) {
  if (MOCK) {
    if (!mock) throw new Error('MOCK_AI=1 but this call has no mock');
    return mock();
  }
  const messages = [{ role: 'system', content: system }, { role: 'user', content: prompt }];

  if (TEXT_PROVIDER === 'ollama') {
    const errors = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        return parseJsonLoose(await chatOllama(messages, { maxTokens, temperature }));
      } catch (error) {
        errors.push(error.message);
        console.warn(`[llm] Ollama attempt ${attempt + 1}/3 failed: ${error.message.slice(0, 200)}`);
      }
    }
    throw new Error(`[llm] all Ollama attempts failed:\n${errors.join('\n')}`);
  }

  const errors = [];
  for (const model of [PRIMARY, PRIMARY, FALLBACK]) {
    try {
      return parseJsonLoose(await chat(model, messages, { maxTokens, temperature }));
    } catch (error) {
      if (error.constructor?.name === 'QuotaExceededError') throw error;
      errors.push(`${model}: ${error.message}`);
      console.warn(`[llm] ${model} failed: ${error.message.slice(0, 200)}`);
    }
  }
  throw new Error(`[llm] all attempts failed:\n${errors.join('\n')}`);
}

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

// Llama 4 Scout: strong JSON adherence at ~1/3 the neuron cost of Llama 3.3
// 70B, which keeps a full day of publishing inside the free allocation.
const PRIMARY = process.env.CF_TEXT_MODEL || '@cf/meta/llama-4-scout-17b-16e-instruct';
const FALLBACK = process.env.CF_TEXT_FALLBACK_MODEL || '@cf/meta/llama-3.3-70b-instruct-fp8-fast';

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

export async function completeJSON(prompt, { system = DEFAULT_SYSTEM, maxTokens = 1500, temperature = 0.8, mock } = {}) {
  if (MOCK) {
    if (!mock) throw new Error('MOCK_AI=1 but this call has no mock');
    return mock();
  }
  const messages = [{ role: 'system', content: system }, { role: 'user', content: prompt }];
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

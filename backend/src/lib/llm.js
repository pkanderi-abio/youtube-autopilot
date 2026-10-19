// Thin wrapper for script/topic generation. Supports local Ollama and
// Google's Gemini API; both return the same JSON-oriented interface to
// the pipeline.
//
// Deliberately no template-based fallback content here. An earlier
// version fell back to a generic templated title/narration whenever
// Ollama failed, so the pipeline always "produced something" - but real
// production evidence showed this made things worse, not better: when
// Ollama entered a sustained bad state (confirmed via CI logs - 9/9
// requests across all retries returning 500 for over 2 minutes
// straight), every attempt fell back to the template, producing a
// visibly broken video (41-word narration, title literally "{topic} in
// {niche}") that still got published. Better to let the failure
// propagate and fail the whole run (skipping that publish cycle
// entirely - see run-pipeline.js's top-level catch) than to publish
// obviously-fallback content.
const LLM_PROVIDER = process.env.LLM_PROVIDER || 'ollama';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.6-flash';
// Meta's Model API - OpenAI-compatible chat completions endpoint. Added as
// an alternative primary provider to Gemini, which has been hitting
// sustained 429 (quota) and 503 (overloaded) errors that force long-form
// generation onto the much weaker Ollama fallback often enough to
// routinely miss the aggregate word-count floor.
const MUSE_API_KEY = process.env.MUSE_API_KEY;
const MUSE_MODEL = process.env.MUSE_MODEL || 'muse-spark-1.3';
const MUSE_BASE_URL = process.env.MUSE_BASE_URL || 'https://api.meta.ai/v1';
// xKiro - OpenAI/Anthropic-compatible gateway reselling 100+ models behind
// one key, several genuinely free (no credit card). Default model picked
// empirically, not just by spec: mistralai/mistral-large-4-0 (the model
// the user originally pointed at) consistently undershot the 130-170 word
// per-section target used throughout 2-generate-script.js (observed
// ~98 words), reproducing the exact "too short, retrying" failure this
// provider swap was meant to fix. qwen/qwen3.8-max:free hit 170/170/170
// across three direct trials with the same prompt shape - free, 1M
// context, and reliably honors length instructions.
const XKIRO_API_KEY = process.env.XKIRO_API_KEY;
const XKIRO_MODEL = process.env.XKIRO_MODEL || 'qwen/qwen3.8-max:free';
const XKIRO_BASE_URL = process.env.XKIRO_BASE_URL || 'https://api.xkiro.com/v1';
const LLM_FALLBACK = process.env.LLM_FALLBACK || 'ollama';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function completeWithOllamaOnce(prompt, { maxTokens, system, json }) {
  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      system,
      stream: false,
      // constrains decoding to syntactically valid JSON - without this,
      // llama3.2 sometimes ignores a "respond with JSON" instruction
      // entirely and returns free-form prose instead (observed directly:
      // "Here is a script for a spoken-word video..." instead of JSON).
      format: json ? 'json' : undefined,
      options: { num_predict: maxTokens }
    })
  });

  if (!response.ok) {
    // Ollama's error body usually explains *why* (e.g. out of memory,
    // context length exceeded) - .statusText alone is just "Internal
    // Server Error" with no useful detail.
    const body = await response.text().catch(() => '');
    throw new Error(`Ollama request failed: ${response.status} ${response.statusText} - ${body.slice(0, 300)}`);
  }

  const data = await response.json();
  return data.response || '';
}

// Observed directly in production: Ollama's server can return a bare
// "500 Internal Server Error" for a request, and keep returning the
// identical error for every immediately-following request in the same
// job - i.e. the server itself enters a bad state (likely resource
// pressure on a shared CPU-only CI runner), not just a one-off blip on
// that specific call. Retrying the exact same request back-to-back hits
// the same wall every time, so this backs off between attempts to give
// the server a real chance to recover before falling back to a template.
async function completeWithOllama(prompt, opts = {}) {
  const { maxTokens = 1024 } = opts;
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await completeWithOllamaOnce(prompt, { ...opts, maxTokens });
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        console.warn(`[llm] Ollama request failed (attempt ${attempt + 1}/3), retrying after backoff:`, error.message);
        await sleep(5000 * (attempt + 1));
      }
    }
  }
  throw lastError;
}

async function completeWithGeminiOnce(prompt, { maxTokens = 1024, system, json } = {}) {
  if (!GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is required when LLM_PROVIDER=gemini');
  }

  const contents = [];
  if (system) contents.push({ role: 'user', parts: [{ text: `System instructions:\n${system}` }] });
  contents.push({ role: 'user', parts: [{ text: prompt }] });
  const generationConfig = {
    // Gemini's reasoning tokens can consume part of the output budget before
    // the JSON payload is emitted. Give structured responses headroom so a
    // valid object is not cut off mid-string.
    maxOutputTokens: Math.min(Math.max(maxTokens * 4, 2048), 8192),
    ...(json ? { responseMimeType: 'application/json' } : {})
  };
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent?key=${encodeURIComponent(GEMINI_API_KEY)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents, generationConfig })
    }
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Gemini request failed: ${response.status} ${response.statusText} - ${body.slice(0, 300)}`);
  }
  const data = await response.json();
  const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('') || '';
  if (!text) throw new Error('Gemini returned no text candidate');
  return text;
}

async function completeWithGemini(prompt, opts = {}) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await completeWithGeminiOnce(prompt, opts);
    } catch (error) {
      lastError = error;
      const retryable = /Gemini request failed: (429|5\d\d)\b/.test(error.message);
      if (!retryable || attempt === 2) throw error;
      console.warn(`[llm] Gemini request failed (attempt ${attempt + 1}/3), retrying after backoff:`, error.message);
      await sleep(2000 * (attempt + 1));
    }
  }
  throw lastError;
}

// Shared by Muse and xKiro - both are plain OpenAI-compatible chat
// completions gateways (same request/response shape, just different base
// URL / key / model string), so the actual HTTP + retry logic is one
// implementation rather than copy-pasted per provider.
async function completeWithOpenAICompatOnce(label, baseUrl, apiKey, model, prompt, { maxTokens = 1024, system } = {}) {
  if (!apiKey) {
    throw new Error(`${label}_API_KEY is required when LLM_PROVIDER=${label.toLowerCase()}`);
  }

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model,
      messages,
      // Not sending response_format: {type:'json_object'} here - it's a
      // de facto OpenAI-compatible convention but wasn't confirmed against
      // either of these specific endpoints, and completeJSON already
      // appends an explicit "respond with ONLY valid JSON" instruction
      // plus does its own fence-stripping/parsing, so correctness doesn't
      // depend on it.
      max_tokens: Math.min(Math.max(maxTokens * 2, 1024), 8192)
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`${label} request failed: ${response.status} ${response.statusText} - ${body.slice(0, 300)}`);
  }
  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || '';
  if (!text) throw new Error(`${label} returned no completion`);
  return text;
}

async function completeWithOpenAICompat(label, baseUrl, apiKey, model, prompt, opts = {}) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await completeWithOpenAICompatOnce(label, baseUrl, apiKey, model, prompt, opts);
    } catch (error) {
      lastError = error;
      const retryable = new RegExp(`${label} request failed: (429|5\\d\\d)\\b`).test(error.message);
      if (!retryable || attempt === 2) throw error;
      console.warn(`[llm] ${label} request failed (attempt ${attempt + 1}/3), retrying after backoff:`, error.message);
      await sleep(2000 * (attempt + 1));
    }
  }
  throw lastError;
}

const completeWithMuse = (prompt, opts) => completeWithOpenAICompat('Muse', MUSE_BASE_URL, MUSE_API_KEY, MUSE_MODEL, prompt, opts);
const completeWithXkiro = (prompt, opts) => completeWithOpenAICompat('Xkiro', XKIRO_BASE_URL, XKIRO_API_KEY, XKIRO_MODEL, prompt, opts);

const PRIMARY_PROVIDERS = {
  gemini: completeWithGemini,
  muse: completeWithMuse,
  xkiro: completeWithXkiro
};

export async function complete(prompt, { maxTokens = 1024, system, json } = {}) {
  const primary = PRIMARY_PROVIDERS[LLM_PROVIDER];
  if (primary) {
    try {
      return await primary(prompt, { maxTokens, system, json });
    } catch (error) {
      if (LLM_FALLBACK !== 'ollama') throw error;
      console.warn(`[llm] ${LLM_PROVIDER} unavailable; using free Ollama fallback: ${error.message}`);
      return completeWithOllama(prompt, { maxTokens, system, json });
    }
  }
  return completeWithOllama(prompt, { maxTokens, system, json });
}

// Strips/escapes raw control characters (charCodes 0-31) that a smaller
// local model sometimes emits unescaped inside JSON string values (e.g.
// a literal newline in the middle of "narration" instead of an escaped
// \n) - a frontier hosted model rarely does this, but it's common enough
// here to reliably break JSON.parse with "Bad control character in
// string literal" and fail the whole run if left unhandled.
function sanitizeJsonControlChars(text) {
  const escapes = { 9: '\\t', 10: '\\n', 13: '\\r' };
  let result = '';
  let insideString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const code = text.charCodeAt(i);

    // Only escape control chars *inside* a string literal - raw
    // whitespace between structural tokens (e.g. the newline in
    // `{\n  "title"`) is already valid JSON as-is; escaping it there
    // injects a literal backslash where none belongs and breaks parsing.
    if (insideString && code <= 31) {
      result += escapes[code] || '';
      escaped = false;
      continue;
    }

    if (ch === '"' && !escaped) insideString = !insideString;
    escaped = insideString && !escaped && ch === '\\';
    result += ch;
  }
  return result;
}

// Asks the model for JSON and parses it, tolerating stray markdown fences.
export async function completeJSON(prompt, opts) {
  const raw = await complete(prompt + '\n\nRespond with ONLY valid JSON, no commentary, no markdown fences.', { ...opts, json: true });
  const cleaned = raw.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(sanitizeJsonControlChars(cleaned));
  } catch (error) {
    throw new Error(`[llm] model response was not valid JSON: ${error.message} - raw: ${cleaned.slice(0, 300)}`);
  }
}

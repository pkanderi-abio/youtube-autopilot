// Thin wrapper for script/topic generation - talks to a local Ollama
// server only. No paid API, no API key: this pipeline is fully
// self-hosted/open-source by design.
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
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';

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

export async function complete(prompt, { maxTokens = 1024, system, json } = {}) {
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

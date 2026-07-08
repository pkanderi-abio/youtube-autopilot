// Thin wrapper for script/topic generation - talks to a local Ollama
// server only. No paid API, no API key: this pipeline is fully
// self-hosted/open-source by design. If Ollama itself is unreachable
// (not installed, not running, model not pulled), falls back to a
// template-based generator so the pipeline still produces *something*
// rather than failing the whole run.
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';

function fallbackTopicPayload(prompt) {
  const niche = (prompt.match(/niche is: ([^\n\.]+)/)?.[1] || 'modern culture').trim();
  const topicCandidates = [...prompt.matchAll(/^\s*\d+\.\s*(.+)$/gm)].map(m => m[1].trim()).filter(Boolean);
  const topic = topicCandidates[0] || `${niche} trends`;
  const angle = topicCandidates[1] ? `A practical take on ${topicCandidates[1]}` : `A fresh angle on ${topic}`;

  return {
    topic,
    angle,
    predictedCtr: 0.62
  };
}

function fallbackScriptPayload(prompt) {
  const channelName = (prompt.match(/channel "([^"]+)"/)?.[1] || 'this channel').trim();
  const niche = (prompt.match(/\(\s*([^\)]+)\s*\)/)?.[1] || 'modern culture').trim();
  const topic = (prompt.match(/Topic:\s*(.+)/)?.[1] || 'today’s biggest trend').trim();
  const angle = (prompt.match(/Angle:\s*(.+)/)?.[1] || `a practical take on ${topic}`).trim();
  const title = `${topic} in ${niche}`;
  const narration = `In this video, we explore ${topic} through the lens of ${channelName}. ${angle}. The goal is to break it down clearly and make it useful for viewers who want to understand what matters right now.`;
  const captionLines = narration.split(/\.\s+/).filter(Boolean).slice(0, 8);
  const description = `This video takes a clear, practical look at ${topic} and why it matters in ${niche}. It is designed to be easy to follow and useful for viewers who want a thoughtful overview.`;
  const tags = [channelName, niche, topic, 'education', 'explainer', 'storytelling'];

  return {
    title: title.length > 90 ? `${title.slice(0, 87)}...` : title,
    narration,
    captionLines,
    description,
    tags
  };
}

function fallbackContent(prompt) {
  const normalized = prompt.toLowerCase();
  if (normalized.includes('"topic"') && normalized.includes('"angle"')) {
    return JSON.stringify(fallbackTopicPayload(prompt));
  }

  if (normalized.includes('"title"') && normalized.includes('"narration"')) {
    return JSON.stringify(fallbackScriptPayload(prompt));
  }

  return `Fallback summary: ${prompt.slice(0, 220)}`;
}

async function completeWithOllama(prompt, { maxTokens = 1024, system, json } = {}) {
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
    throw new Error(`Ollama request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.response || '';
}

export async function complete(prompt, { maxTokens = 1024, system, json } = {}) {
  try {
    return await completeWithOllama(prompt, { maxTokens, system, json });
  } catch (error) {
    console.warn('[llm] Ollama unavailable, using template fallback:', error.message);
    return fallbackContent(prompt);
  }
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
    console.warn('[llm] model response was not valid JSON, using template fallback:', error.message);
    return JSON.parse(fallbackContent(prompt));
  }
}

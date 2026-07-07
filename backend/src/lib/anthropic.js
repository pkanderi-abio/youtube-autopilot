// Thin wrapper for script/topic generation.
// Prefers a local Ollama model when available to avoid API costs.
// Falls back to Anthropic if an API key is present.
import Anthropic from '@anthropic-ai/sdk';

const anthropicClient = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const MODEL = 'claude-3-5-haiku-20241022';
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';

async function completeWithOllama(prompt, { maxTokens = 1024 } = {}) {
  const response = await fetch(`${OLLAMA_URL}/api/generate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: OLLAMA_MODEL,
      prompt,
      stream: false,
      options: { num_predict: maxTokens }
    })
  });

  if (!response.ok) {
    throw new Error(`Ollama request failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  return data.response || '';
}

export async function complete(prompt, { maxTokens = 1024, system } = {}) {
  if (!anthropicClient) {
    return completeWithOllama(prompt, { maxTokens });
  }

  const msg = await anthropicClient.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }]
  });
  return msg.content.map(b => (b.type === 'text' ? b.text : '')).join('');
}

// Asks the provider for JSON and parses it, tolerating stray markdown fences.
export async function completeJSON(prompt, opts) {
  const raw = await complete(prompt + '\n\nRespond with ONLY valid JSON, no commentary, no markdown fences.', opts);
  const cleaned = raw.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
  return JSON.parse(cleaned);
}

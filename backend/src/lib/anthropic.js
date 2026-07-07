// Thin wrapper around the Anthropic SDK for script/topic generation.
import Anthropic from '@anthropic-ai/sdk';

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Cheap, fast model - plenty for short-form scripts. Bump to a larger
// model in MODEL if you want punchier writing and don't mind the cost.
const MODEL = 'claude-3-5-haiku-20241022';

export async function complete(prompt, { maxTokens = 1024, system } = {}) {
  const msg = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: prompt }]
  });
  return msg.content.map(b => (b.type === 'text' ? b.text : '')).join('');
}

// Asks Claude for JSON and parses it, tolerating stray markdown fences.
export async function completeJSON(prompt, opts) {
  const raw = await complete(prompt + '\n\nRespond with ONLY valid JSON, no commentary, no markdown fences.', opts);
  const cleaned = raw.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
  return JSON.parse(cleaned);
}

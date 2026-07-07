// Thin wrapper for script/topic generation.
// Prefers a local Ollama model when available to avoid API costs.
// Falls back to Anthropic if an API key is present.
import Anthropic from '@anthropic-ai/sdk';

const anthropicClient = process.env.ANTHROPIC_API_KEY
  ? new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  : null;

const MODEL_CANDIDATES = Array.from(new Set([
  process.env.ANTHROPIC_MODEL,
  'claude-3-5-haiku-latest',
  'claude-3-5-haiku-20241022',
  'claude-3-5-sonnet-latest'
].filter(Boolean)));
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://127.0.0.1:11434';
const OLLAMA_MODEL = process.env.OLLAMA_MODEL || 'llama3.2';

function fallbackTopicPayload(prompt) {
  const channelName = (prompt.match(/channel called "([^"]+)"/)?.[1] || 'this channel').trim();
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

function isModelUnavailableError(error) {
  const message = error?.message || '';
  return /model|not_found|404/i.test(message);
}

async function completeWithAnthropic(prompt, { maxTokens = 1024, system } = {}) {
  let lastError;

  for (const model of MODEL_CANDIDATES) {
    try {
      const msg = await anthropicClient.messages.create({
        model,
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: prompt }]
      });
      return msg.content.map(b => (b.type === 'text' ? b.text : '')).join('');
    } catch (error) {
      lastError = error;
      if (!isModelUnavailableError(error)) {
        throw error;
      }
    }
  }

  throw lastError || new Error('Anthropic request failed');
}

export async function complete(prompt, { maxTokens = 1024, system } = {}) {
  if (!anthropicClient) {
    try {
      return await completeWithOllama(prompt, { maxTokens });
    } catch (error) {
      return fallbackContent(prompt);
    }
  }

  try {
    return await completeWithAnthropic(prompt, { maxTokens, system });
  } catch (error) {
    try {
      return await completeWithOllama(prompt, { maxTokens });
    } catch (ollamaError) {
      return fallbackContent(prompt);
    }
  }
}

// Asks the provider for JSON and parses it, tolerating stray markdown fences.
export async function completeJSON(prompt, opts) {
  const raw = await complete(prompt + '\n\nRespond with ONLY valid JSON, no commentary, no markdown fences.', opts);
  const cleaned = raw.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
  return JSON.parse(cleaned);
}

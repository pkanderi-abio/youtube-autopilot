// Thin fetch-based wrapper around OpenAI's image generation endpoint -
// no SDK, matching this repo's existing pattern (see lib/anthropic.js's
// Ollama call) of using plain fetch for external HTTP APIs. Used only by
// channels with visualStyle "illustrated" (see 4-generate-background.js).
const OPENAI_IMAGES_URL = 'https://api.openai.com/v1/images/generations';

export async function generateSceneImage(prompt, { width, height }) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('Missing OPENAI_API_KEY');
  }

  const size = width >= height ? '1536x1024' : '1024x1536';

  const res = await fetch(OPENAI_IMAGES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      model: 'gpt-image-1',
      prompt,
      size,
      quality: 'low',
      n: 1
    })
  });

  if (!res.ok) {
    throw new Error(`OpenAI image generation failed: ${res.status} ${await res.text()}`);
  }

  const data = await res.json();
  return Buffer.from(data.data[0].b64_json, 'base64');
}

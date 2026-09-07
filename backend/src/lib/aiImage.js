// Google Imagen still-image generation for narration-aligned shots.
// The generated stills are animated by step 5 with a Ken Burns move so
// every short has bespoke visuals without downloading stock footage.

const IMAGE_MODEL = process.env.GEMINI_IMAGE_MODEL || 'imagen-4.0-generate-001';
const API_KEY = process.env.GEMINI_API_KEY;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function generateOnce(prompt, aspectRatio) {
  if (!API_KEY) throw new Error('GEMINI_API_KEY is required for aiGenerated visuals');

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(IMAGE_MODEL)}:predict?key=${encodeURIComponent(API_KEY)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        instances: [{ prompt }],
        parameters: { sampleCount: 1, aspectRatio, outputMimeType: 'image/png' }
      })
    }
  );

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Imagen request failed: ${response.status} ${response.statusText} - ${body.slice(0, 300)}`);
  }

  const data = await response.json();
  const encoded = data.predictions?.[0]?.bytesBase64Encoded;
  if (!encoded) throw new Error('Imagen returned no image bytes');
  return Buffer.from(encoded, 'base64');
}

export async function generateAiImage(query, { aspectRatio = '9:16' } = {}) {
  const prompt = [
    `Create an original cinematic editorial illustration of: ${query}.`,
    'Use realistic or cinematic 3D visual storytelling appropriate for a factual short video.',
    'Show one clear subject or event, strong depth, dramatic but believable lighting, and useful background detail.',
    'No words, captions, logos, flags, watermarks, UI, or collage panels.',
    'Do not depict graphic injury, gore, or identifiable private people.'
  ].join(' ');

  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      return await generateOnce(prompt, aspectRatio);
    } catch (error) {
      lastError = error;
      const retryable = /Imagen request failed: (429|5\d\d)\b/.test(error.message);
      if (!retryable || attempt === 2) throw error;
      console.warn(`[ai-image] generation failed (attempt ${attempt + 1}/3), retrying: ${error.message}`);
      await sleep(2000 * (attempt + 1));
    }
  }
  throw lastError;
}

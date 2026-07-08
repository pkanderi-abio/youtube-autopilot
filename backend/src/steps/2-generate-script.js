// Step 2 - turn the chosen topic+angle into a spoken script, a title,
// a description, and tags - everything downstream steps need. Channels
// with an illustrated visual style also get a `scenes` array: short
// visual-description prompts for step 4 to turn into per-scene images.
import { completeJSON } from '../lib/llm.js';

// llama3.2 (a small local model) is unreliable about hitting a
// requested word count - sometimes by a little, sometimes drastically
// (observed directly: a "short" video that should run ~45-55s spoken
// came out at 11.89s of actual audio, meaning the model wrote something
// like 25-30 words instead of 110-150). A too-short narration produces
// a video so brief there's barely time for any background variety to
// register, which reads as "static" regardless of how the background
// itself is generated. So: retry a few times and keep the longest
// narration seen rather than accepting whatever comes back first.
const MIN_WORDS = { short: 90, long: 550 };
const MAX_ATTEMPTS = 3;

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

export async function generateScript(channel, topicInfo) {
  const durationHint = channel.format === 'short'
    ? 'roughly 110-150 words (about 45-55 seconds spoken)'
    : 'roughly 700-900 words (about 6-8 minutes spoken)';

  const closingLineHint = channel.madeForKids
    ? 'End with a short, cheerful line inviting the viewer to sing along or watch again - do not ask for comments (comments are disabled on kids content).'
    : 'End with a short line that invites a comment or follow, no generic "like and subscribe".';

  const scenesHint = channel.visualStyle === 'illustrated'
    ? `
  "scenes": ["short visual description 1", "short visual description 2", "..."],`
    : '';

  const scenesInstructions = channel.visualStyle === 'illustrated'
    ? `
- Also produce a "scenes" array: 8-14 short visual descriptions (for an
  illustrator), covering the video's progression in order. Each should
  describe a single clear scene/character/action - no on-screen text, no
  narration text, just what should be drawn.`
    : '';

  const minWords = MIN_WORDS[channel.format === 'short' ? 'short' : 'long'];

  function buildPrompt(previousAttemptWordCount) {
    const lengthEmphasis = previousAttemptWordCount
      ? `\n\nIMPORTANT: a previous attempt only produced ${previousAttemptWordCount} words, which is far too short. The "narration" field MUST be a full ${durationHint.match(/[\d-]+ words/)[0]} - write it out completely, don't stop early.`
      : '';

    return `
Write a spoken-word video script for the YouTube channel "${channel.name}" (${channel.niche}).

Topic: ${topicInfo.topic}
Angle: ${topicInfo.angle}

Requirements:
- Hook in the first sentence, no throat-clearing intro.
- Conversational, punchy, plain language - written to be read aloud by a narrator.
- ${durationHint}.
- ${closingLineHint}
- Do not claim to be human, do not fabricate statistics or quotes as fact - keep claims general/opinion-based.
- Create 3-5 high-quality hashtags based on the topic and channel niche.${scenesInstructions}

Return JSON:
{
  "title": "YouTube title, under 90 characters, no clickbait ALL CAPS",
  "narration": "the full script as continuous prose, ready to feed to a TTS engine",
  "captionLines": ["short caption chunk 1", "short caption chunk 2", "..."],
  "description": "2-3 sentence YouTube description",
  "tags": ["tag1", "tag2", "tag3"],
  "hashtags": ["#hashtag1", "#hashtag2", "#hashtag3"],${scenesHint}
}

captionLines should split the narration into 6-12 short on-screen chunks (roughly one breath/phrase each) covering the whole narration in order.${lengthEmphasis}
`.trim();
  }

  let best = null;
  let lastWordCount = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const script = await completeJSON(buildPrompt(lastWordCount), { maxTokens: channel.format === 'short' ? 1024 : 4096 });
    const words = wordCount(script.narration || '');
    if (!best || words > wordCount(best.narration)) best = script;
    if (words >= minWords) return script;
    console.warn(`[script] attempt ${attempt + 1}/${MAX_ATTEMPTS} narration too short (${words}/${minWords} min words), retrying`);
    lastWordCount = words;
  }

  console.warn(`[script] all ${MAX_ATTEMPTS} attempts came in short - using the longest one (${wordCount(best.narration)} words)`);
  return best;
}

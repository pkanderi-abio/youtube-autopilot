// Step 2 - turn the chosen topic+angle into a spoken script, a title,
// a description, and tags - everything downstream steps need. Channels
// with an illustrated visual style also get a `scenes` array: short
// visual-description prompts for step 4 to turn into per-scene images.
import { completeJSON } from '../lib/anthropic.js';

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

  const script = await completeJSON(`
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

captionLines should split the narration into 6-12 short on-screen chunks (roughly one breath/phrase each) covering the whole narration in order.
`.trim());

  return script;
}

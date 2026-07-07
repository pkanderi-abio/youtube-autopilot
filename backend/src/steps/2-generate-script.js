// Step 2 - turn the chosen topic+angle into a spoken script, a title,
// a description, and tags - everything downstream steps need.
import { completeJSON } from '../lib/anthropic.js';

export async function generateScript(channel, topicInfo) {
  const durationHint = channel.format === 'short'
    ? 'roughly 110-150 words (about 45-55 seconds spoken)'
    : 'roughly 700-900 words (about 6-8 minutes spoken)';

  const script = await completeJSON(`
Write a spoken-word video script for the YouTube channel "${channel.name}" (${channel.niche}).

Topic: ${topicInfo.topic}
Angle: ${topicInfo.angle}

Requirements:
- Hook in the first sentence, no throat-clearing intro.
- Conversational, punchy, plain language - written to be read aloud by a narrator.
- ${durationHint}.
- End with a short line that invites a comment or follow, no generic "like and subscribe".
- Do not claim to be human, do not fabricate statistics or quotes as fact - keep claims general/opinion-based.

Return JSON:
{
  "title": "YouTube title, under 90 characters, no clickbait ALL CAPS",
  "narration": "the full script as continuous prose, ready to feed to a TTS engine",
  "captionLines": ["short caption chunk 1", "short caption chunk 2", "..."],
  "description": "2-3 sentence YouTube description",
  "tags": ["tag1", "tag2", "tag3"]
}

captionLines should split the narration into 6-12 short on-screen chunks (roughly one breath/phrase each) covering the whole narration in order.
`.trim());

  return script;
}

// Step 2 - turn the chosen topic+angle into a spoken script, a title,
// a description, and tags - everything downstream steps need.
// Stock-footage channels also get a `scenes` array: short visual
// phrases for step 4 to use as per-shot footage search queries.
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

// Long-form (channel2) scripts need 700-900 words, but real production
// evidence showed llama3.2 asked for that in one completion just stops
// early regardless of how the prompt emphasizes length (best of 3 retries
// came in at 238 words - well under half the floor). Splitting the ask
// into several small, independently-retried sections is far more
// achievable per-call than one giant completion, even though it costs
// more Ollama round-trips per run.
const LONG_FORM_SECTIONS = 5;
const MAX_LONG_FORM_SECTIONS = 8;
const MIN_WORDS_PER_SECTION = 100;

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

// Mechanical safety net for the "no clickbait ALL CAPS" instruction,
// which a small local model doesn't reliably follow (observed directly:
// "GIANTS MAKE WILD COMEBACK WIN AT METLIFE STADIUM"). Cheaper and more
// reliable than hoping the model self-corrects.
function fixAllCapsTitle(title) {
  const letters = title.replace(/[^a-zA-Z]/g, '');
  const upperCount = (title.match(/[A-Z]/g) || []).length;
  if (letters.length > 0 && upperCount / letters.length > 0.6) {
    return title.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  }
  return title;
}

function nicheReinforcement(channel) {
  return `The script must be EXPLICITLY about ${channel.niche} - don't just
  narrate the topic in isolation (e.g. a plain sports recap or news
  summary with no connection to the niche). Every script should sound
  like it clearly belongs to this channel, not a generic video that
  happens to have the channel's name slapped on it.`;
}

function closingLineHint(channel) {
  return channel.madeForKids
    ? 'End with a short, cheerful line inviting the viewer to sing along or watch again - do not ask for comments (comments are disabled on kids content).'
    : 'End with a short line that invites a comment or follow, no generic "like and subscribe".';
}

// Stock-footage channels need a per-shot "scenes" array - short concrete
// phrases that work well as Pexels search terms (not full descriptive
// sentences, which return far fewer/worse stock-footage matches).
function needsScenes(channel) {
  return channel.visualStyle === 'stockFootage';
}

function scenesFields(channel, countHint) {
  if (!needsScenes(channel)) return { hint: '', instructions: '' };

  return {
    hint: `
  "scenes": ["short visual phrase 1", "short visual phrase 2", "..."],`,
    instructions: `
- Also produce a "scenes" array: ${countHint} short visual phrases (3-6
  words each, concrete nouns, e.g. "aerial coastal city sunset" or
  "toddler stacking colorful blocks") describing what should be shown on
  screen at each part of the video, in order - these are used as
  stock-footage search queries, so keep them concrete and literal, not
  full sentences.`
  };
}

// ---- short-form (channel1): single-shot generation - unchanged from
// before, since real production evidence only ever showed this format
// failing due to the Ollama server crashing, not the model undershooting
// the (much lower) 110-150 word target. ----
async function generateShortScript(channel, topicInfo) {
  const durationHint = 'roughly 110-150 words (about 45-55 seconds spoken)';
  const minWords = MIN_WORDS.short;
  const { hint: scenesHint, instructions: scenesInstructions } = scenesFields(channel, '5-8');

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
- ${nicheReinforcement(channel)}
- ${durationHint}.
- ${closingLineHint(channel)}
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
    const script = await completeJSON(buildPrompt(lastWordCount), { maxTokens: 1024 });
    const words = wordCount(script.narration || '');
    if (!best || words > wordCount(best.narration)) best = script;
    if (words >= minWords) break;
    console.warn(`[script] attempt ${attempt + 1}/${MAX_ATTEMPTS} narration too short (${words}/${minWords} min words), retrying`);
    lastWordCount = words;
  }

  if (wordCount(best.narration) < minWords) {
    // Publishing a too-short video is exactly the "static/broken" quality
    // problem this floor exists to prevent - better to fail this run and
    // skip publishing than upload something visibly broken.
    throw new Error(`[script] narration too short after ${MAX_ATTEMPTS} attempts (best: ${wordCount(best.narration)}/${minWords} words) - aborting instead of publishing`);
  }
  best.title = fixAllCapsTitle(best.title);
  return best;
}

// ---- long-form (channel2): outline + metadata first, then narration
// generated section-by-section and concatenated. ----
async function generateScriptOutline(channel, topicInfo) {
  const { hint: scenesHint, instructions: scenesInstructions } = scenesFields(channel, '8-14');

  const prompt = `
You are planning a spoken-word YouTube video for the channel "${channel.name}" (${channel.niche}).

Topic: ${topicInfo.topic}
Angle: ${topicInfo.angle}

This is a long-form video (6-8 minutes spoken). Don't write the narration
yet - just plan its structure and the video's metadata.

Requirements:
- ${nicheReinforcement(channel)}
- Create 3-5 high-quality hashtags based on the topic and channel niche.${scenesInstructions}

Return JSON:
{
  "title": "YouTube title, under 90 characters, no clickbait ALL CAPS",
  "description": "2-3 sentence YouTube description",
  "tags": ["tag1", "tag2", "tag3"],
  "hashtags": ["#hashtag1", "#hashtag2", "#hashtag3"],
  "sections": ["one sentence describing what the opening hook covers", "one sentence describing the next narrative beat", "..."],${scenesHint}
}

"sections" must have exactly ${LONG_FORM_SECTIONS} entries, in order, describing
the video's narrative arc from hook to close - each entry is a plan for
what that part of the narration should cover, not the narration itself.
`.trim();

  return completeJSON(prompt, { maxTokens: 1024 });
}

async function generateNarrationSection(channel, topicInfo, sectionBrief, index, total, previousTail) {
  const isFirst = index === 0;
  const isLast = index === total - 1;
  const positionHint = isFirst
    ? 'This is the OPENING section - hook the viewer in the first sentence, no throat-clearing intro.'
    : isLast
      ? `This is the CLOSING section. ${closingLineHint(channel)}`
      : 'This is a MIDDLE section - continue directly from where the narration left off, no new intro and no wrap-up yet.';

  const continuityHint = previousTail
    ? `\n\nThe narration so far ends with: "...${previousTail}"\nContinue naturally from there - do not repeat it, do not restart the video.`
    : '';

  function buildPrompt(previousAttemptWordCount) {
    const lengthEmphasis = previousAttemptWordCount
      ? `\n\nIMPORTANT: a previous attempt only produced ${previousAttemptWordCount} words, which is too short. Write a full 130-170 words for this section - don't stop early.`
      : '';

    return `
Write ONE section of a spoken-word video script for the YouTube channel
"${channel.name}" (${channel.niche}).

Topic: ${topicInfo.topic}
Angle: ${topicInfo.angle}

This section's role: ${sectionBrief}
${positionHint}${continuityHint}

Requirements:
- Conversational, punchy, plain language - written to be read aloud by a narrator.
- ${nicheReinforcement(channel)}
- Roughly 130-170 words for this section only.
- Do not claim to be human, do not fabricate statistics or quotes as fact - keep claims general/opinion-based.

Return JSON:
{
  "narration": "just this section's narration, as continuous prose",
  "captionLines": ["short caption chunk 1", "short caption chunk 2", "..."]
}

captionLines should split this section's narration into 2-3 short on-screen chunks (roughly one breath/phrase each).${lengthEmphasis}
`.trim();
  }

  let best = null;
  let lastWordCount = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const section = await completeJSON(buildPrompt(lastWordCount), { maxTokens: 1024 });
    const words = wordCount(section.narration || '');
    if (!best || words > wordCount(best.narration)) best = section;
    if (words >= MIN_WORDS_PER_SECTION) break;
    console.warn(`[script] section ${index + 1}/${total} attempt ${attempt + 1}/${MAX_ATTEMPTS} too short (${words}/${MIN_WORDS_PER_SECTION} min words), retrying`);
    lastWordCount = words;
  }

  if (wordCount(best.narration) < MIN_WORDS_PER_SECTION) {
    throw new Error(`[script] section ${index + 1}/${total} narration too short after ${MAX_ATTEMPTS} attempts (best: ${wordCount(best.narration)}/${MIN_WORDS_PER_SECTION} words) - aborting instead of publishing`);
  }
  return best;
}

async function generateLongScript(channel, topicInfo) {
  const outline = await generateScriptOutline(channel, topicInfo);
  // "exactly N entries" in the outline prompt is a request, not a
  // guarantee - llama3.2 doesn't reliably comply (observed directly:
  // asked for 5, returned 8). That's harmless in itself (more, smaller
  // sections still land near the target total), but uncapped it risks a
  // degenerate response ballooning run time and word count - so clamp
  // rather than trust the array length as-is.
  const sections = (outline.sections?.length ? outline.sections : new Array(LONG_FORM_SECTIONS).fill('continue the video'))
    .slice(0, MAX_LONG_FORM_SECTIONS);

  let narration = '';
  let captionLines = [];
  for (let i = 0; i < sections.length; i++) {
    const tail = narration ? narration.trim().split(/\s+/).slice(-40).join(' ') : '';
    const section = await generateNarrationSection(channel, topicInfo, sections[i], i, sections.length, tail);
    narration += (narration ? ' ' : '') + section.narration.trim();
    captionLines = captionLines.concat(section.captionLines || []);
  }

  const words = wordCount(narration);
  if (words < MIN_WORDS.long) {
    throw new Error(`[script] combined long-form narration too short (${words}/${MIN_WORDS.long} words) - aborting instead of publishing`);
  }

  return {
    title: fixAllCapsTitle(outline.title),
    narration,
    captionLines,
    description: outline.description,
    tags: outline.tags,
    hashtags: outline.hashtags || [],
    scenes: outline.scenes
  };
}

export async function generateScript(channel, topicInfo) {
  if (channel.format === 'short') {
    return generateShortScript(channel, topicInfo);
  }
  return generateLongScript(channel, topicInfo);
}

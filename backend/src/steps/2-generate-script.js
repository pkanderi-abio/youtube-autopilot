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

// Detects vague-abstract titles that don't tell a viewer what the video
// is actually about - the kind of thing that reads as filler and won't
// earn a click. Observed directly in production output: "The Beauty of
// Influence", "The Chemistry That Fizzled", "The Emotional Price of
// Greatness", "Ball Pit Bliss". A good title names something specific:
// a real person, place, event, or a concrete number/quantity.
const TITLE_STOPWORDS = new Set([
  'the','a','an','and','or','but','for','to','of','in','on','at','by',
  'with','from','into','over','under','after','before','is','are','was',
  'were','be','been','being','how','why','what','when','where','this',
  'that','these','those','it','its','you','your','our','their'
]);

// Common abstract nouns we've seen the model reach for when it doesn't
// have a specific hook - if the title is BUILT from these plus stopwords
// it reads as pure filler.
const ABSTRACT_TITLE_WORDS = new Set([
  'beauty','chemistry','emotion','emotional','price','greatness','haunting',
  'influence','bliss','revolution','effect','impact','power','magic',
  'wonder','mystery','story','tale','journey','moment','world','life',
  'love','heart','soul','truth','reality','experience','feeling','side',
  'rise','fall','dark','hidden','secret','psychology','future','past',
  'legacy','culture','phenomenon','thing','things','way','ways'
]);

function titleLooksVague(title) {
  if (!title) return true;
  const cleaned = title.replace(/[^a-zA-Z0-9\s'’]/g, ' ');
  const words = cleaned.split(/\s+/).filter(Boolean);
  if (words.length < 4) return true;
  // A digit anywhere = concrete number/year/count. Passes.
  if (/\d/.test(title)) return false;
  // A possessive apostrophe (e.g. "Fiji's", "McGregor's") almost always
  // names a specific person or place. Passes.
  if (/['’]s\b/i.test(title)) return false;
  // Otherwise: does it contain at least one substantive word that isn't
  // in the stopword+abstract-noun blocklist? If every content word is
  // either a stopword or a pure abstract noun ("The Beauty of Influence"),
  // it's vague.
  const contentWords = words.filter(w => !TITLE_STOPWORDS.has(w.toLowerCase()));
  const concreteContent = contentWords.filter(w => !ABSTRACT_TITLE_WORDS.has(w.toLowerCase()));
  return concreteContent.length < 2;
}

// Post-generation title polish - if the narration is fine but the title
// came out vague, ask the model to rewrite JUST the title using the
// script content as grounding. Cheaper than regenerating the whole
// script, and it doesn't disturb narration length (which the retry
// loops above are already carefully protecting).
async function polishTitle(channel, topicInfo, script) {
  if (!titleLooksVague(script.title)) return script.title;

  const narrationExcerpt = (script.narration || '').split(/\s+/).slice(0, 60).join(' ');

  console.warn(`[script] title "${script.title}" reads as vague/abstract - requesting concrete rewrite`);
  const attempts = 2;
  let best = script.title;
  for (let i = 0; i < attempts; i++) {
    try {
      const out = await completeJSON(`
Rewrite the YouTube title for this ${channel.format}-form video to make it
concrete and click-worthy.

Channel: ${channel.name} (${channel.niche})
Topic: ${topicInfo.topic}
Angle: ${topicInfo.angle}
Script opening: "${narrationExcerpt}..."

Current title (too vague/abstract): "${script.title}"

Rules for the new title:
- Under 90 characters, no ALL-CAPS words.
- MUST name something specific: a real person, place, event, number,
  year, or concrete thing that appears in the script - not abstract
  nouns like "Beauty", "Chemistry", "Influence", "Journey", "Story".
- Bad examples (do NOT produce these):
    "The Beauty of Influence"
    "The Chemistry That Fizzled"
    "The Emotional Price of Greatness"
    "Ball Pit Bliss"
- Good examples (this shape):
    "Fiji's Best Hidden Beaches for 2026 Travelers"
    "5 Underrated Cities to Visit This Winter"
    "Why the Tortoise Beat the Hare (Full Story)"

Return JSON: { "title": "..." }
`.trim(), { maxTokens: 200 });

      const rewritten = fixAllCapsTitle((out.title || '').trim());
      if (rewritten && !titleLooksVague(rewritten)) return rewritten;
      if (rewritten) best = rewritten;
    } catch (err) {
      console.warn(`[script] title polish attempt ${i + 1}/${attempts} failed:`, err.message);
    }
  }
  // Fall back to whatever we ended with - the pipeline shouldn't die
  // over an imperfect title.
  return best;
}

function nicheReinforcement(channel) {
  return `The script must be EXPLICITLY about ${channel.niche} - don't just
  narrate the topic in isolation (e.g. a plain sports recap or news
  summary with no connection to the niche). Every script should sound
  like it clearly belongs to this channel, not a generic video that
  happens to have the channel's name slapped on it.`;
}

function closingLineHint(channel) {
  if (channel.contentStyle === 'babyLearning') {
    return `End with a warm cheer for the toddler and an invitation to
    sing/count/watch again next time - short and sweet. Examples:
    "Great job counting with me! Come back and count again soon!" or
    "Yay! You learned all the colors! Let's sing again next time!"
    Do not ask for comments (comments are disabled on kids content).`;
  }
  if (channel.closingStyle === 'moral') {
    return 'End by clearly stating the moral or lesson of the story in one sentence - what the viewer should take away from it.';
  }
  if (channel.madeForKids) {
    return 'End with a short, cheerful line inviting the viewer to watch again - do not ask for comments (comments are disabled on kids content).';
  }
  return 'End with a short line that invites a comment or follow, no generic "like and subscribe".';
}

// Returns the "hook + prose style" bullet block used in the short-form
// single-shot prompt. For adult content, this enforces the aggressive
// first-3-seconds hook YouTube Shorts needs. For baby/toddler content
// (contentStyle: "babyLearning") that "grab-and-keep" framing is wrong -
// the audience is a 1-4 year old whose parent is holding the phone;
// the win condition is warmth, repetition, and clarity, not a
// scroll-stopping surprise.
function hookAndStyleInstructions(channel) {
  if (channel.contentStyle === 'babyLearning') {
    return `- OPENING: greet the baby/toddler directly and name what
  today's video is teaching. Examples: "Hi little friends! Today we
  count from one to ten!" or "Hello babies! Let's sing Twinkle
  Twinkle Little Star!". NO adult-style hook, NO surprising facts,
  NO shocking claims.
- VOCABULARY: simple 1-2 syllable words wherever possible; very short
  sentences (4-8 words each).
- HIGHLY REPETITIVE - repeat key words and phrases 3-4 times each.
  Repetition is HOW toddlers learn: "Red apple! Red apple! Can you
  say red? Red!"
- Direct interactive prompts throughout: "Can you count with me?",
  "Point to the ___!", "What sound does the ___ make?", "Say it with me!"
- Warm, patient, encouraging tone. Cheer throughout: "Great job!",
  "Yay!", "You're so smart!", "Amazing!"
- Rhyming or sing-song rhythm when it fits naturally - for a nursery
  rhyme topic, include the well-known public-domain lyrics verbatim.
- NO complex ideas, NO scary/sad content, NO abstract morals.`;
  }
  return `- HOOK (the first 3 seconds decide everything on YouTube Shorts):
  the FIRST SENTENCE must be a specific surprising fact, a number,
  or a concrete promise that makes a scrolling viewer stop.
  NEVER start with "In this video...", "Today we'll...", "Let's
  explore...", "Did you know that maybe...", or any throat-clearing.
  BAD:  "In this video we'll explore Fiji's beaches."
  BAD:  "Today let's talk about the tortoise and the hare."
  GOOD: "There's an island in Fiji with water so clear you can see
        30 feet down - and almost nobody visits it."
  GOOD: "This tiny animal outsmarted a champion racer just by
        walking. Here's how."
- Use "you" / "your" often - direct address holds attention.
- Present tense, active verbs, short sentences.
- Conversational, punchy, plain language - written to be read aloud by a narrator.`;
}

// Long-form equivalents of hookAndStyleInstructions - the opening
// section's brief, and the prose-style bullet used inside every
// section's prompt. Kept as separate helpers because the long-form
// section prompt is much smaller than the single-shot short prompt
// and shouldn't repeat the full style block on every section call.
function openingSectionHint(channel) {
  if (channel.contentStyle === 'babyLearning') {
    return `This is the OPENING section. Greet the baby/toddler directly
    and name what today's video is teaching. Example: "Hi little
    friends! Today we're going to learn colors together! Are you
    ready?". NO adult-style hook, NO surprising claims. Warmth and
    clarity matter, not scroll-stopping. Set up the repetitive /
    sing-along pattern the rest of the video will use.`;
  }
  return `This is the OPENING section. The FIRST SENTENCE must be a specific
       surprising fact, number, or concrete promise that makes the viewer
       stop scrolling - NEVER "In this video...", "Today we'll...", "Let's
       explore...", or any throat-clearing setup. Use "you"/"your" and
       present tense.
       BAD:  "In this video we'll tell the story of the tortoise and the hare."
       GOOD: "A tortoise once beat the fastest animal in the forest - just by walking. Here's how."`;
}

function sectionProseStyle(channel) {
  if (channel.contentStyle === 'babyLearning') {
    return `- Simple 1-2 syllable vocabulary; very short sentences (4-8 words each).
- HIGHLY REPETITIVE - repeat key words and phrases 3-4 times.
- Direct interactive prompts: "Say it with me!", "Can you point to the ___?".
- Warm, patient, cheering tone throughout ("Yay!", "Great job!").
- Rhyming/sing-song where natural (include well-known nursery rhyme lyrics for those topics).
- NO scary/sad content, NO complex ideas, NO abstract morals.`;
  }
  return `- Conversational, punchy, plain language - written to be read aloud by a narrator.`;
}

// Stock-footage channels need a per-shot "scenes" array - short concrete
// phrases that work well as Pexels search terms (not full descriptive
// sentences, which return far fewer/worse stock-footage matches).
function needsScenes(channel) {
  return channel.visualStyle === 'stockFootage';
}

function scenesFields(channel, countHint) {
  if (!needsScenes(channel)) return { hint: '', instructions: '' };

  const isBaby = channel.contentStyle === 'babyLearning';
  const examples = isBaby
    ? '"cute yellow ducks swimming", "red juicy apple on table", "colorful balloons floating", "puppy playing with ball", "baby playing with toys"'
    : '"aerial coastal city sunset" or "fox running through forest"';
  const extra = isBaby
    ? `\n  For baby/toddler content specifically: prefer bright, cheerful,
  concrete objects the video is teaching about (animals, food, toys,
  colorful things). Search phrases like "cute puppy playing" work far
  better on stock-footage sites than abstract phrases like "concept of
  counting" - Pexels has thousands of matching real clips for concrete
  kid-friendly nouns.`
    : '';

  return {
    hint: `
  "scenes": ["short visual phrase 1", "short visual phrase 2", "..."],`,
    instructions: `
- Also produce a "scenes" array: ${countHint} short visual phrases (3-6
  words each, concrete nouns, e.g. ${examples}) describing what should
  be shown on screen at each part of the video, in order - these are
  used as stock-footage search queries, so keep them concrete and
  literal, not full sentences.${extra}`
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
${hookAndStyleInstructions(channel)}
- ${nicheReinforcement(channel)}
- ${durationHint}.
- ${closingLineHint(channel)}
- Do not claim to be human, do not fabricate statistics or quotes as fact - keep claims general/opinion-based.
- Create 3-5 high-quality hashtags based on the topic and channel niche.${scenesInstructions}

Return JSON:
{
  "title": "YouTube title (under 90 chars, no ALL-CAPS words) - MUST name something specific: a real person, place, event, number, year, or concrete thing from the script. NOT abstract nouns like 'Beauty', 'Chemistry', 'Influence', 'Journey', 'Story', 'Bliss'. Bad: 'The Beauty of Influence'. Good: 'Fiji's Best Hidden Beaches for 2026 Travelers' or '5 Cities to Visit This Winter'",
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
  best.title = await polishTitle(channel, topicInfo, best);
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
  "title": "YouTube title (under 90 chars, no ALL-CAPS words) - MUST name something specific: a real person, place, event, number, year, or concrete thing from the topic. NOT abstract nouns like 'Beauty', 'Chemistry', 'Influence', 'Journey', 'Story', 'Bliss'. Bad: 'The Beauty of Influence'. Good: 'Why the Tortoise Beat the Hare (Full Story)' or '5 Underrated Cities to Visit This Winter'",
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
    ? openingSectionHint(channel)
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
${sectionProseStyle(channel)}
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
    // Don't abort the whole run over one under-target section - real
    // production evidence showed this threshold gets missed by a
    // handful of words often enough to matter (e.g. 97/100), even
    // though the section is still usable narration and the *aggregate*
    // narration across all sections routinely clears the real quality
    // bar (MIN_WORDS.long, checked once all sections are in). Keep the
    // longest attempt and move on; generateLongScript's total-word check
    // is the real safety net against publishing something too short.
    console.warn(`[script] section ${index + 1}/${total} still short after ${MAX_ATTEMPTS} attempts (best: ${wordCount(best.narration)}/${MIN_WORDS_PER_SECTION} words) - keeping it and continuing`);
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

  const result = {
    title: fixAllCapsTitle(outline.title),
    narration,
    captionLines,
    description: outline.description,
    tags: outline.tags,
    hashtags: outline.hashtags || [],
    scenes: outline.scenes
  };
  result.title = await polishTitle(channel, topicInfo, result);
  return result;
}

// When skipNarration is true, we generate only the metadata YouTube
// upload needs (title/description/tags/hashtags/scenes) - no narration.
// Used when the pipeline already has a pre-recorded audio file for
// this topic (e.g. bundled sung nursery rhyme), so any narration the
// LLM produces would be thrown away. Cuts a long-form run's script
// step from ~5 minutes (section-by-section) to a single outline call.
async function generateMetadataOnly(channel, topicInfo) {
  const outline = await generateScriptOutline(channel, topicInfo);
  return {
    title: await polishTitle(channel, topicInfo, {
      title: fixAllCapsTitle(outline.title),
      narration: outline.description || ''
    }),
    narration: '',
    captionLines: [],
    description: outline.description,
    tags: outline.tags,
    hashtags: outline.hashtags || [],
    scenes: outline.scenes
  };
}

export async function generateScript(channel, topicInfo, opts = {}) {
  if (opts.skipNarration) {
    return generateMetadataOnly(channel, topicInfo);
  }
  if (channel.format === 'short') {
    return generateShortScript(channel, topicInfo);
  }
  return generateLongScript(channel, topicInfo);
}

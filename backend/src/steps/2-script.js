// Step 2 - write the video as a STORYBOARD: an ordered list of scenes, each
// with the exact narration spoken over it and a self-contained image prompt
// for what's on screen. Because voice is synthesized per scene (step 4),
// every image is on screen exactly while its own words are spoken - no
// after-the-fact alignment heuristics needed.
//
// Short: one call. Long: an outline call, then one call per section that
// gets the previous section's tail for continuity (a single 1,000-word ask
// reliably undershoots). Fail loud if the total is too short.
import { completeJSON, MOCK } from '../lib/llm.js';

const LIMITS = {
  short: { minWords: 90, targetWords: '120-150', scenes: '7-9', sceneSentences: '1-2' },
  long: { minWords: 650, sectionWords: '150-190', sectionMin: 110, sectionScenes: '5-7', sections: 6 }
};
// Toddler content uses 4-8 word sentences, so the same 50 seconds holds far
// fewer words (run #463: 53-64 words per short and ~55 per long section, vs 90/110 floors).
const BABY_LIMITS = {
  // floors set from what the model actually writes in this style (~50-65
  // words per short / per long section); ~330 toddler-pace words ≈ 3 minutes
  short: { minWords: 50, targetWords: '80-110', scenes: '8-10', sceneSentences: '2-3 very short' },
  long: { minWords: 300, sectionWords: '90-130', sectionMin: 45, sectionScenes: '6-8', sections: 6 }
};
const limitsFor = (channel, format) => (channel.contentStyle === 'babyLearning' ? BABY_LIMITS : LIMITS)[format];

const words = (t) => String(t || '').split(/\s+/).filter(Boolean).length;
const totalWords = (scenes) => scenes.reduce((n, s) => n + words(s.narration), 0);

function voiceRules(channel) {
  if (channel.contentStyle === 'babyLearning') {
    return `Audience: babies and toddlers (ages 1-4), watched with a parent.
- Greet the child directly and say what we'll learn ("Hi little friends! Let's count ducks!").
- Very short sentences (4-8 words), simple words, lots of gentle repetition.
- Interactive prompts: "Can you say red?", "Count with me!", "What does the cow say?".
- Warm, cheerful praise ("Great job!", "Yay!"). Nothing scary, sad or complex.
- For a nursery rhyme topic, include the traditional public-domain lyrics.
- End with a happy goodbye and an invitation to sing again.`;
  }
  const closing = channel.closingStyle === 'moral'
    ? '- End with a one-line lesson that follows naturally from the story.'
    : '- End with a short payoff line, then one natural line inviting viewers to follow for more.';
  return `- The FIRST sentence is the hook: a specific surprising fact, number, or promise about THIS topic.
  Never open with "In this video", "Today we", "Let's explore" or "Did you know".
- Conversational, present tense, "you" often, contractions, varied sentence length.
- Only claims you are confident are true; no invented statistics or precise numbers you can't back.
- Write only spoken words: no stage directions, labels, emojis or parentheticals.
${closing}`;
}

function visualRules(channel) {
  return `Each scene's "visual" is a standalone prompt for an AI image generator:
- Describe ONE clear moment: main subject, what it's doing, setting, camera angle, lighting.
- Must depict what THAT scene's narration is about - concrete and specific to this topic.
- Repeat key character/place details from "visualBible" so images stay consistent.
- No text, letters, numbers, captions, logos, watermarks or split panels in the image.
- No real identifiable people's faces, no gore, nothing unsafe for ${channel.madeForKids ? 'young children' : 'a general audience'}.
- Vary shots (wide, close-up, overhead, low angle) across scenes.`;
}

function cleanScenes(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map((s) => ({
      narration: String(s?.narration || '').replace(/\s+/g, ' ').trim(),
      visual: String(s?.visual || '').replace(/\s+/g, ' ').trim()
    }))
    .filter((s) => s.visual && (s.narration || s.narration === ''));
}

// Same sentence 3+ times usually means the model looped (refrains in baby
// content are expected, so that style gets a higher threshold).
function hasLoopedContent(scenes, tolerant) {
  const counts = new Map();
  for (const sentence of scenes.map((s) => s.narration).join(' ').toLowerCase().split(/[.!?]+/)) {
    const key = sentence.replace(/[^a-z0-9 ]/g, '').trim();
    if (key.split(' ').length < 5) continue;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return [...counts.values()].some((n) => n >= (tolerant ? 6 : 3));
}

function mockScenes(topic, n, prefix = '') {
  return Array.from({ length: n }, (_, i) => ({
    narration: `${prefix}Scene ${i + 1} about ${topic}. ${prefix}detail number ${i + 1} is the surprising part that keeps you watching until the end.`,
    visual: `${topic}, moment ${i + 1}, wide cinematic shot`
  }));
}

async function shortScript(channel, topicInfo) {
  const L = limitsFor(channel, 'short');
  let best = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const out = await completeJSON(`
Write a YouTube Short for "${channel.name}" (${channel.niche}).
Topic: ${topicInfo.topic}
Angle: ${topicInfo.angle}

Narration rules (total ${L.targetWords} words, about 50 seconds spoken):
${voiceRules(channel)}

Split it into ${L.scenes} scenes of ${L.sceneSentences} sentences each.
${visualRules(channel)}
${best ? `\nYour previous attempt was only ${totalWords(best.scenes)} words - write the full ${L.targetWords}.` : ''}

Return JSON: {
  "visualBible": "1-2 sentences fixing the look of recurring characters/places/objects",
  "scenes": [{"narration": "...", "visual": "..."}]
}`.trim(), {
      maxTokens: 1600,
      mock: () => ({ visualBible: `${topicInfo.topic}, consistent look`, scenes: mockScenes(topicInfo.topic, 8) })
    });
    const scenes = cleanScenes(out.scenes);
    const candidate = { visualBible: String(out.visualBible || ''), scenes };
    if (hasLoopedContent(scenes, channel.contentStyle === 'babyLearning')) {
      console.warn(`[script] attempt ${attempt + 1} repeated itself, retrying`);
      continue;
    }
    if (!best || totalWords(scenes) > totalWords(best.scenes)) best = candidate;
    if (totalWords(scenes) >= L.minWords && scenes.length >= 5) break;
    console.warn(`[script] attempt ${attempt + 1}: ${totalWords(scenes)} words / ${scenes.length} scenes, retrying`);
  }
  if (!best || totalWords(best.scenes) < L.minWords) {
    throw new Error(`[script] short narration too short (${best ? totalWords(best.scenes) : 0}/${L.minWords} words) - aborting`);
  }
  return best;
}

async function longScript(channel, topicInfo) {
  const L = limitsFor(channel, 'long');
  const outline = await completeJSON(`
Plan a ${L.sections}-section long-form YouTube video (about 7 minutes) for "${channel.name}" (${channel.niche}).
Topic: ${topicInfo.topic}
Angle: ${topicInfo.angle}

Section 1 opens with the hook; the last section wraps up. Each section covers a DIFFERENT sub-point
so nothing is repeated. Also write a "visualBible" fixing the look of recurring characters/places.

Return JSON: {"visualBible": "...", "sections": [{"heading": "...", "brief": "2 sentences on what this section covers"}]}`.trim(), {
    maxTokens: 900,
    mock: () => ({ visualBible: topicInfo.topic, sections: Array.from({ length: L.sections }, (_, i) => ({ heading: `Part ${i + 1}`, brief: `Point ${i + 1}` })) })
  });
  const sections = (outline.sections || []).slice(0, 8);
  if (sections.length < 3) throw new Error('[script] outline had fewer than 3 sections');

  const scenes = [];
  for (const [i, section] of sections.entries()) {
    const tail = scenes.slice(-2).map((s) => s.narration).join(' ');
    let sectionScenes = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const out = await completeJSON(`
You are writing section ${i + 1} of ${sections.length} of a long-form video for "${channel.name}" (${channel.niche}).
Topic: ${topicInfo.topic}
Full outline: ${sections.map((s, j) => `${j + 1}. ${s.heading}`).join(' | ')}
THIS section: "${section.heading}" - ${section.brief}
Visual bible: ${outline.visualBible}
${tail ? `The previous section ended with: "${tail}" - continue smoothly, do not repeat it.` : 'This is the opening - start with the hook.'}
${i < sections.length - 1 ? 'Do NOT wrap up the video yet.' : 'This is the final section - wrap up.'}

Narration rules (${L.sectionWords} words for this section):
${voiceRules(channel)}

Split this section into ${L.sectionScenes} scenes of 1-3 sentences.
${visualRules(channel)}

Return JSON: {"scenes": [{"narration": "...", "visual": "..."}]}`.trim(), {
        maxTokens: 1400,
        mock: () => ({ scenes: mockScenes(topicInfo.topic, 6, `Part ${i + 1} `) })
      });
      const candidate = cleanScenes(out.scenes);
      if (hasLoopedContent([...scenes, ...candidate], channel.contentStyle === 'babyLearning')) {
        console.warn(`[script] section ${i + 1} attempt ${attempt + 1} repeats earlier narration, retrying`);
        continue;
      }
      if (totalWords(candidate) > totalWords(sectionScenes)) sectionScenes = candidate;
      if (totalWords(candidate) >= L.sectionMin) break;
      console.warn(`[script] section ${i + 1} attempt ${attempt + 1} short (${totalWords(candidate)} words), retrying`);
    }
    scenes.push(...sectionScenes);
  }
  const total = totalWords(scenes);
  if (!MOCK && total < L.minWords) throw new Error(`[script] long narration too short (${total}/${L.minWords} words) - aborting`);
  if (hasLoopedContent(scenes, channel.contentStyle === 'babyLearning')) {
    throw new Error('[script] long narration repeats itself - aborting');
  }
  return { visualBible: String(outline.visualBible || ''), scenes };
}

// Sung-recording videos (bundled nursery audio): no narration, just a
// sequence of visuals following the rhyme.
async function visualsOnly(channel, topicInfo, count) {
  const out = await completeJSON(`
Plan ${count} illustrations for a toddler sing-along video of "${topicInfo.topic}".
Follow the traditional rhyme's story in order, one moment per illustration, then
playful variations of the main characters for the remaining ones.
For each, give "lyric" (the matching line of the rhyme or "" if none) and "visual".
${visualRules(channel)}

Return JSON: {"visualBible": "...", "scenes": [{"lyric": "...", "visual": "..."}]}`.trim(), {
    maxTokens: 1800,
    mock: () => ({ visualBible: topicInfo.topic, scenes: mockScenes(topicInfo.topic, count).map((s) => ({ lyric: '', visual: s.visual })) })
  });
  const scenes = (out.scenes || []).map((s) => ({ narration: '', caption: String(s.lyric || ''), visual: String(s.visual || '').trim() }))
    .filter((s) => s.visual);
  if (scenes.length < Math.min(4, count)) throw new Error('[script] too few sing-along scenes');
  return { visualBible: String(out.visualBible || ''), scenes, sung: true };
}

export async function generateScript(channel, topicInfo, { sungSceneCount } = {}) {
  if (sungSceneCount) return visualsOnly(channel, topicInfo, sungSceneCount);
  const script = channel.format === 'long' ? await longScript(channel, topicInfo) : await shortScript(channel, topicInfo);
  script.narration = script.scenes.map((s) => s.narration).join(' ');
  return script;
}

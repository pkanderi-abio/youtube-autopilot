// Step 3 - dedicated SEO/metadata pass: title, description, tags,
// hashtags, and a first-comment hook. Deliberately split out from script
// generation (step 2) rather than requested in the same call - mirrors
// how a real content team separates "write the script" from "optimize
// for search/CTR", and grounding the title/description in the FINISHED
// narration (instead of guessing before the script exists, which is what
// the single-call approach used to do) produces metadata that actually
// matches what the video says.
import { completeJSON } from '../lib/llm.js';

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

// Recent-title similarity guard - fixes a real production issue: three
// separate "Fiji's Best Hidden Beaches" videos within a week on
// channel1, and five differently-worded "Mary Had a Little Lamb" videos
// within two weeks on channel2. Those titles were distinct STRINGS, so
// nothing caught them - but they share almost all their substantive
// words, which reads as the same video to both a viewer scrolling a
// channel page and to YouTube's recommendation/dedup systems.
function normalizeForComparison(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter(w => !TITLE_STOPWORDS.has(w));
}

function titleTooSimilar(candidate, recentTitles) {
  const candidateWords = new Set(normalizeForComparison(candidate));
  if (candidateWords.size === 0) return false;
  for (const recent of recentTitles) {
    const recentWords = new Set(normalizeForComparison(recent));
    if (recentWords.size === 0) continue;
    const shared = [...candidateWords].filter(w => recentWords.has(w));
    const overlap = shared.length / Math.min(candidateWords.size, recentWords.size);
    if (shared.length >= 2 && overlap >= 0.6) return true;
  }
  return false;
}

const RECENT_TITLES_WINDOW = 15;
const MAX_TITLE_FIX_ATTEMPTS = 2;

export async function optimizeSeo(channel, topicInfo, script, history) {
  const recentTitles = (history.videos || []).slice(-RECENT_TITLES_WINDOW).map(v => v.title);
  const narrationExcerpt = script.narration
    ? script.narration.split(/\s+/).slice(0, 220).join(' ')
    : null;

  const prompt = `
You are the SEO optimization specialist for the YouTube channel "${channel.name}" (${channel.niche}).
You did not write this video's script - your only job is the title, description, tags, hashtags, and a first-comment hook that will get this specific video found and clicked.

Topic: ${topicInfo.topic}
Angle: ${topicInfo.angle}
${narrationExcerpt
    ? `Script excerpt (ground your metadata in what the video actually says):\n"${narrationExcerpt}..."`
    : 'This video has no spoken narration (it uses a pre-recorded sing-along track) - base metadata on the topic/angle above.'}

Recently published titles on this channel - DO NOT reuse the same subject/angle as any of these. Viewers and YouTube's recommendation system treat near-duplicate titles as repeat content, which hurts reach:
${recentTitles.length ? recentTitles.map(t => `- ${t}`).join('\n') : '(no prior videos yet)'}

Requirements:
- "title": under 90 characters, no ALL-CAPS words. MUST name something specific: a real place, number, year, or concrete thing from the script/topic - not abstract nouns like "Beauty", "Chemistry", "Influence", "Journey", "Story", "Bliss".
  Bad: "The Beauty of Influence". Good: "Fiji's Best Hidden Beaches for 2026 Travelers" or "5 Cities to Visit This Winter".
  Must be a clearly DIFFERENT subject/angle from every title listed above - don't just add a year or reword one of them.
- "description": 4-6 sentences. FIRST SENTENCE is the SEO hook (appears in search snippets) and MUST include the main keywords a viewer would type to find this video. Middle sentences give more context and mention 1-2 related things by name. LAST sentence is a subscribe/comment CTA. NO generic "Welcome to my channel" openers.
- "tags": 3-6 specific search-relevant tags (not generic single words like "video" or "fun").
- "hashtags": 3-5 hashtags based on the topic and channel niche.
- "commentCta": one-sentence question or hook to post as the FIRST COMMENT on the video (from the channel owner). Should invite replies. Keep under 140 chars.

Return JSON: { "title": "...", "description": "...", "tags": ["..."], "hashtags": ["#..."], "commentCta": "..." }
`.trim();

  const result = await completeJSON(prompt, { maxTokens: 500 });
  result.title = fixAllCapsTitle((result.title || '').trim());

  // Up to two corrective rewrite passes for a vague/abstract title or one
  // that's too similar to something recently published. Cheaper than
  // regenerating the whole metadata set, and doesn't touch narration.
  for (let attempt = 0; attempt < MAX_TITLE_FIX_ATTEMPTS; attempt++) {
    const dup = titleTooSimilar(result.title, recentTitles);
    const vague = !dup && titleLooksVague(result.title);
    if (!dup && !vague) break;

    const reason = dup
      ? `Current title "${result.title}" is too similar to a recently published title on this channel - pick a different specific angle or detail from the topic/script, don't just tweak the wording.`
      : `Current title "${result.title}" reads as vague/abstract, not concrete.`;
    console.warn(`[seo] ${reason} retrying (attempt ${attempt + 1}/${MAX_TITLE_FIX_ATTEMPTS})`);

    try {
      const rewritten = await completeJSON(`
Rewrite ONLY the YouTube title for this ${channel.format}-form video.

Channel: ${channel.name} (${channel.niche})
Topic: ${topicInfo.topic}
Angle: ${topicInfo.angle}
${reason}

Recently published titles to avoid overlapping with:
${recentTitles.map(t => `- ${t}`).join('\n') || '(none)'}

Rules: under 90 characters, no ALL-CAPS words, must name something
specific (a real person, place, event, number, year, or concrete thing).

Return JSON: { "title": "..." }
`.trim(), { maxTokens: 200 });
      const candidate = fixAllCapsTitle((rewritten.title || '').trim());
      if (candidate) result.title = candidate;
    } catch (err) {
      console.warn(`[seo] title rewrite attempt ${attempt + 1}/${MAX_TITLE_FIX_ATTEMPTS} failed:`, err.message);
      break;
    }
  }

  result.tags = result.tags || [];
  result.hashtags = result.hashtags || [];
  result.commentCta = result.commentCta || '';
  return result;
}

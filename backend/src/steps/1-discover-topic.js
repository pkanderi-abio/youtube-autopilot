// Step 1 - pick today's topic for a channel. Most channels pull trending
// searches; evergreen content (e.g. nursery rhymes, moral fables) doesn't
// fit "what's trending today", so a channel can instead define a
// `topicPool` in config/channels.json - a curated list it draws from
// unrelated to daily trends. Either way, the model picks the single best
// fit for the channel's niche and predicts a rough CTR.
import { fetchDailyTrends } from '../lib/trends.js';
import { completeJSON } from '../lib/llm.js';
import { poolPerformanceHint } from '../lib/analytics.js';

// A pool item can only be picked once per cooldown window - real
// production evidence showed the opposite (a pure "already used this
// exact string" filter) let the LLM reuse the same base rhyme/fact
// under a superficially different invented topic string 3-5x within two
// weeks ("Mary Had a Little Lamb" as "Mary and Little Lamb Count Colors
// Together", "Counting with Mary and Her Little Lambs", etc - none of
// which matched history.usedTopics literally, so the old filter never
// caught it). Tracking the actual pool item a topic was drawn from
// (persisted as sourcePoolItem on each history video entry) lets us
// enforce real spacing regardless of how the topic gets reworded.
const POOL_COOLDOWN_VIDEOS = 6;

function recentlyUsedPoolItems(history, count) {
  return history.videos.slice(-count).map(v => v.sourcePoolItem).filter(Boolean);
}

async function pickPool(channel, history) {
  if (channel.topicPool?.length) {
    const onCooldown = new Set(recentlyUsedPoolItems(history, POOL_COOLDOWN_VIDEOS));
    let candidates = channel.topicPool.filter(t => !onCooldown.has(t));
    if (!candidates.length) {
      // Every item is on cooldown (pool smaller than the cooldown
      // window, or a burst of runs) - degrade to "anything but the
      // single most recent pick" rather than reusing back-to-back.
      const mostRecent = history.videos[history.videos.length - 1]?.sourcePoolItem;
      candidates = channel.topicPool.filter(t => t !== mostRecent);
      if (!candidates.length) candidates = channel.topicPool;
    }
    return { pool: candidates, isTrending: false };
  }

  const trends = await fetchDailyTrends();
  const candidates = trends.filter(t => !history.usedTopics.includes(t));
  return { pool: candidates.length ? candidates : trends, isTrending: true };
}

export async function discoverTopic(channel, history) {
  const { pool, isTrending } = await pickPool(channel, history);
  const poolLabel = isTrending ? "today's trending searches" : 'candidate topics for this channel';
  const performanceHint = await poolPerformanceHint(channel.id, history, isTrending);

  // Observed failure mode with a small local model: it picks a raw
  // trending term (a sports score, a news anchor's name) and writes a
  // generic recap with no real connection to the channel's niche - e.g.
  // a travel/lifestyle channel publishing sports-highlight-reel videos.
  // The fix is a much more directive, example-driven prompt: the
  // returned "topic" must already read as a niche topic, not a bare
  // trending term, and a term with no plausible tie-in should be
  // reframed or replaced rather than used as-is.
  //
  // That "discard it and invent something else instead" permission is
  // ONLY appropriate for trending mode, where a candidate genuinely can
  // be pure garbage (a raw sports score with zero plausible niche tie-
  // in). Applying the same permission to topicPool candidates - which
  // are already hand-curated to fit the niche - backfired in
  // production: given a perfectly good candidate like "The Loudest
  // Sound Ever Recorded Was Heard 3,000 Miles Away", the model would
  // still exercise its "invent something else" option and produce an
  // unrelated topic ("Fiji's 40-Kilometer Shore"), or even borrow a
  // DIFFERENT candidate's fact while claiming a mismatched sourceIndex
  // ("The Town Built Entirely Underground..." attributed to a topic
  // that was actually about a sinking city). The pool's curated
  // diversity is wasted if the model just freelances anyway - so pool
  // mode gets a stricter, fidelity-required instruction with no escape
  // hatch, since there's never a legitimate reason to need one here.
  const escapeHatchInstructions = isTrending
    ? `If a term has no real connection to this niche (e.g. a raw sports
score, a news anchor's name, an unrelated event), do not just write a
generic video about that term - either find a genuine angle that ties
it to the niche, or discard it and invent a different topic that
clearly fits the niche instead.

Example (niche: travel & lifestyle):
- Candidate: "Super Bowl" -> good topic: "The most underrated cities to
  visit for next year's Super Bowl" (ties the trend to travel).
- Candidate: "Local team wins championship game" -> BAD: a sports recap
  video has no travel/lifestyle angle. Either skip it or invent an
  unrelated but niche-fitting topic instead.`
    : `Every candidate above was already hand-picked to fit this niche -
none of them need to be discarded or replaced, and there is no reason
to invent an unrelated substitute. Your "topic" MUST be about the SAME
specific fact/place/subject named in the candidate you choose - you may
restate it more concretely or give it a sharper hook, but do not swap
in a different fact, a different place, or another candidate's subject.`;

  const picked = await completeJSON(`
You are the content strategist for a YouTube channel called "${channel.name}",
whose niche is: ${channel.niche}.

Here are ${poolLabel}:
${pool.map((t, i) => `${i + 1}. ${t}`).join('\n')}
${performanceHint}

Your job is to turn ONE of these into a video topic that is EXPLICITLY
about ${channel.niche} - not a recap of the term in isolation. ${escapeHatchInstructions}

The "topic" field you return must already read as a ${channel.niche}
topic, not a bare copy of the candidate. The "angle" field must state
specifically why/how it connects to the niche.

Return JSON: {
  "topic": "...",
  "angle": "one sentence on the specific angle/hook",
  "predictedCtr": 0.0,
  "sourceIndex": <the NUMBER of the candidate you based this on, from the numbered list above - just the integer, e.g. 3>
}
`.trim());

  // Asking for the source item back as an INDEX rather than an exact
  // text echo, and validating it's an in-range integer, rather than
  // trusting a copied-verbatim string. Real production evidence: the
  // exact-string-match version silently failed whenever the model
  // reworded the pool item even slightly while writing "topic" (e.g.
  // dropping "in the World" from "The Smallest Country in the World
  // You Could Walk Across in 20 Minutes") - sourceItem then didn't
  // match anything in `pool`, sourcePoolItem was recorded as null, and
  // the cooldown in pickPool() never saw that pick, so the SAME pool
  // item got selected again 8 hours and one video later. A small
  // integer index is much harder for a small model to get wrong than
  // reproducing a text span byte-for-byte.
  const index = Number(picked.sourceIndex);
  const sourcePoolItem = !isTrending && Number.isInteger(index) && index >= 1 && index <= pool.length
    ? pool[index - 1]
    : null;
  return { ...picked, sourcePoolItem };
}

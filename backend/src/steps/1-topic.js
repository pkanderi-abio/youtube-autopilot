// Step 1 - pick the topic. Channels with a curated `topicPool` draw from it
// (with a cooldown so the same item can't recur within POOL_COOLDOWN
// videos); `useLiveTrends` channels mix in Google's daily trends RSS.
//
// Lessons kept from production:
// - The model returns `sourceIndex` (an integer) instead of echoing the
//   candidate text back. Text echo silently broke the cooldown whenever the
//   model paraphrased - an index is much harder to get wrong.
// - Pool candidates are pre-curated, so the model gets NO "invent something
//   else" escape hatch there (it used to freelance unrelated topics).
import { fetchDailyTrends } from '../lib/trends.js';
import { completeJSON } from '../lib/llm.js';
import { poolPerformanceHint } from '../lib/analytics.js';

// An item can't recur until at least this share of the pool has been used
// since (6 was the old fixed cooldown: with ~35 items the model kept
// cycling the same handful every ~7 videos).
const POOL_COOLDOWN_SHARE = 0.6;
const MIN_POOL_COOLDOWN = 6;
const MAX_CANDIDATES = 12;

const STOP = new Set('the a an of to in on and or is are was its it that this with for from by at as be you your why how what if than but'.split(' '));
export function topicWords(text) {
  return new Set(String(text).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/)
    .filter((w) => w.length > 2 && !STOP.has(w))
    .map((w) => (w.length > 4 ? w.replace(/(es|s)$/, '') : w)));
}
function overlap(a, b) {
  const wa = topicWords(a);
  let n = 0;
  for (const w of topicWords(b)) if (wa.has(w)) n++;
  return n;
}

// Pool items ordered least-recently-used first (never-used items first of
// all), with everything used inside the cooldown window removed.
export function candidatePool(channel, history) {
  const items = channel.topicPool || [];
  if (!items.length) return [];
  const videos = history.videos || [];
  const cooldown = Math.min(items.length - 1, Math.max(MIN_POOL_COOLDOWN, Math.floor(items.length * POOL_COOLDOWN_SHARE)));
  const lastUsed = new Map();
  videos.forEach((v, i) => { if (v.sourcePoolItem) lastUsed.set(v.sourcePoolItem, i); });
  const recent = new Set(videos.slice(-cooldown).map((v) => v.sourcePoolItem).filter(Boolean));
  const lru = (list) => list
    .map((t) => ({ t, at: lastUsed.get(t) ?? -1, r: Math.random() }))
    .sort((a, b) => a.at - b.at || a.r - b.r)
    .map((x) => x.t);
  const fresh = items.filter((t) => !recent.has(t));
  return lru(fresh.length ? fresh : items.filter((t) => t !== videos.at(-1)?.sourcePoolItem));
}

export async function discoverTopic(channel, history) {
  const pool = candidatePool(channel, history);
  let trends = [];
  if (channel.useLiveTrends || !pool.length) {
    trends = (await fetchDailyTrends()).filter((t) => !history.usedTopics.includes(t)).slice(0, 12);
  }
  // Offer only the least-recently-used items, shuffled so the model doesn't
  // always favour the top of the list.
  const shuffled = pool.slice(0, MAX_CANDIDATES).sort(() => Math.random() - 0.5);
  const candidates = [
    ...shuffled.map((text) => ({ text, kind: 'pool' })),
    ...trends.map((text) => ({ text, kind: 'trend' }))
  ];
  if (!candidates.length) throw new Error('[topic] no candidates (empty pool and no trends)');

  const hint = await poolPerformanceHint(channel.id, history, false);
  const recentTitles = history.videos.slice(-12).map((v) => v.title);

  const picked = await completeJSON(`
You are the content strategist for the YouTube channel "${channel.name}".
Niche: ${channel.niche}
Format: ${channel.format === 'short' ? 'YouTube Short (under 60 seconds, vertical)' : 'long-form video (6-9 minutes)'}

Candidates (P = hand-picked for this niche, T = today's trending search):
${candidates.map((c, i) => `${i + 1}. [${c.kind === 'pool' ? 'P' : 'T'}] ${c.text}`).join('\n')}
${hint}

Recently published (do not repeat these subjects):
${recentTitles.map((t) => `- ${t}`).join('\n') || '(none)'}

Rules:
- [P] candidates already fit the niche. If you pick one, your topic MUST be
  about the same specific subject - sharpen the hook, do not swap subjects.
- [T] candidates are raw search terms. Only pick one if there is a genuine,
  factual angle that fits the niche (no gossip, politics, or score recaps).
- The topic must be visual: something an illustrator could depict scene by scene.

Return JSON: {"sourceIndex": <integer from the list>, "topic": "...", "angle": "one sentence on the hook"}
`.trim(), {
    maxTokens: 300,
    temperature: 0.7,
    mock: () => ({ sourceIndex: 1, topic: candidates[0].text, angle: `A quick visual look at ${candidates[0].text}` })
  });

  const idx = Number(picked.sourceIndex);
  let chosen = Number.isInteger(idx) && idx >= 1 && idx <= candidates.length ? candidates[idx - 1] : null;
  const topic = String(picked.topic || chosen?.text || '').trim();
  // Cross-check the index against the topic the model actually wrote: it
  // sometimes gives the index of one candidate and writes about another
  // (e.g. index of "Why Venice..." with topic "Sweden's 24,000 Islands"),
  // which put the wrong item on cooldown and let the real one repeat.
  if (topic) {
    const best = candidates
      .map((c) => ({ c, score: overlap(c.text, topic) }))
      .sort((a, b) => b.score - a.score)[0];
    const chosenScore = chosen ? overlap(chosen.text, topic) : 0;
    if (best && best.score > chosenScore) {
      console.warn(`[topic] sourceIndex ${idx} ("${chosen?.text}") doesn't match topic "${topic}" - using "${best.c.text}"`);
      chosen = best.c;
    }
  }
  if (!topic) throw new Error('[topic] model returned no topic');
  return {
    topic,
    angle: String(picked.angle || '').trim(),
    sourcePoolItem: chosen?.kind === 'pool' ? chosen.text : null,
    trend: chosen?.kind === 'trend' ? chosen.text : null
  };
}

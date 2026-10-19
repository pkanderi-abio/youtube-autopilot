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

const POOL_COOLDOWN = 6;

function candidatePool(channel, history) {
  const recent = new Set(history.videos.slice(-POOL_COOLDOWN).map((v) => v.sourcePoolItem).filter(Boolean));
  let pool = (channel.topicPool || []).filter((t) => !recent.has(t));
  if (!pool.length && channel.topicPool?.length) {
    const last = history.videos.at(-1)?.sourcePoolItem;
    pool = channel.topicPool.filter((t) => t !== last);
  }
  return pool;
}

export async function discoverTopic(channel, history) {
  const pool = candidatePool(channel, history);
  let trends = [];
  if (channel.useLiveTrends || !pool.length) {
    trends = (await fetchDailyTrends()).filter((t) => !history.usedTopics.includes(t)).slice(0, 12);
  }
  // Shuffle the pool so the model doesn't always favour the top of the list.
  const shuffled = [...pool].sort(() => Math.random() - 0.5).slice(0, 15);
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
  const chosen = Number.isInteger(idx) && idx >= 1 && idx <= candidates.length ? candidates[idx - 1] : null;
  const topic = String(picked.topic || chosen?.text || '').trim();
  if (!topic) throw new Error('[topic] model returned no topic');
  return {
    topic,
    angle: String(picked.angle || '').trim(),
    sourcePoolItem: chosen?.kind === 'pool' ? chosen.text : null,
    trend: chosen?.kind === 'trend' ? chosen.text : null
  };
}

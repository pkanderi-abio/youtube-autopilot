// Step 1 - pick today's topic for a channel: pull trending searches,
// filter out anything already used, then let Claude pick the single
// best fit for this channel's niche and predict a rough CTR score.
import { fetchDailyTrends } from '../lib/trends.js';
import { completeJSON } from '../lib/anthropic.js';

export async function discoverTopic(channel, history) {
  const trends = await fetchDailyTrends();
  const candidates = trends.filter(t => !history.usedTopics.includes(t));
  const pool = candidates.length ? candidates : trends;

  const picked = await completeJSON(`
You are the content strategist for a YouTube channel called "${channel.name}",
whose niche is: ${channel.niche}.

Here are today's trending search topics:
${pool.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Pick the ONE topic that best fits this channel's niche and is likely to get
strong watch time as a ${channel.format === 'short' ? '30-60 second Short' : '6-10 minute video'}.
If none fit well, invent a related angle that still ties back to something
on this list.

Return JSON: { "topic": "...", "angle": "one sentence on the specific angle/hook", "predictedCtr": 0.0 }
`.trim());

  return picked;
}

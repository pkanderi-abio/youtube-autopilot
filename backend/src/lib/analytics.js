// Best-effort read of data/analytics-<channelId>.json (written by
// scripts/fetch-analytics.js on its own daily schedule, via the YouTube
// Data API) to fold real view-count signal back into topic selection -
// the analytics-feedback-loop piece this pipeline otherwise lacked
// entirely. Missing/stale analytics data is the normal case for a young
// channel or before the first analytics run has happened, so every
// failure here is silently absorbed into "no hint" rather than blocking
// topic discovery.
import { readFile } from 'fs/promises';
import path from 'path';

const DATA_DIR = path.resolve('data');
const MIN_ITEMS_FOR_HINT = 6; // too few distinct pool items to be a meaningful signal

async function loadAnalytics(channelId) {
  try {
    const raw = await readFile(path.join(DATA_DIR, `analytics-${channelId}.json`), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// Groups analytics rows by the evergreen pool item that sourced them,
// averages views per item, and returns a short prompt-ready block naming
// the best/worst performing items so the model can lean into angles that
// have worked and give a fresher spin on ones that haven't - grounded in
// real performance data instead of a guess. Returns '' when there isn't
// enough data yet (trending-mode channels, or too few analytics points).
export async function poolPerformanceHint(channelId, history, isTrending) {
  if (isTrending) return '';

  const analytics = await loadAnalytics(channelId);
  if (!analytics?.videos?.length) return '';

  const byItem = new Map();
  for (const v of analytics.videos) {
    if (!v.sourcePoolItem) continue;
    const entry = byItem.get(v.sourcePoolItem) || { totalViews: 0, count: 0 };
    entry.totalViews += v.viewCount || 0;
    entry.count += 1;
    byItem.set(v.sourcePoolItem, entry);
  }
  if (byItem.size < MIN_ITEMS_FOR_HINT) return '';

  const ranked = [...byItem.entries()]
    .map(([item, { totalViews, count }]) => ({ item, avgViews: totalViews / count }))
    .sort((a, b) => b.avgViews - a.avgViews);

  const best = ranked.slice(0, 3).map(r => r.item);
  const worst = ranked.slice(-3).map(r => r.item);

  return `
Real view-count data from this channel's past videos (use this to inform
your pick - lean toward angles similar to what's worked, and give a
fresher spin on items that haven't):
- Best-performing topics recently: ${best.join('; ')}
- Weakest-performing topics recently: ${worst.join('; ')}`;
}

// Free, keyless trend sources. google-trends-api scrapes Google's public
// "daily trends" endpoint - no quota, but it's unofficial and can break;
// the fallback list keeps the pipeline running if it does.
import googleTrends from 'google-trends-api';

const FALLBACK_SEEDS = [
  'a viral moment people are talking about today',
  'a surprising everyday life hack',
  'a strange but true fact',
  'something oddly satisfying',
  'a common misconception, debunked',
  'a "did you know" style curiosity'
];

export async function fetchDailyTrends(geo = 'US') {
  try {
    const raw = await googleTrends.dailyTrends({ geo });
    const parsed = JSON.parse(raw);
    const days = parsed.default?.trendingSearchesDays ?? [];
    const searches = days.flatMap(d => d.trendingSearches ?? []);
    return searches
      .map(s => s.title?.query)
      .filter(Boolean)
      .slice(0, 20);
  } catch (err) {
    console.warn('[trends] google-trends-api failed, using fallback seeds:', err.message);
    return FALLBACK_SEEDS;
  }
}

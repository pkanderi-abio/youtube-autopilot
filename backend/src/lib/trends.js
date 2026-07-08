// Free, keyless trend source: Google's public "Daily Search Trends" RSS
// feed. (The google-trends-api npm package this used to call scrapes an
// older internal endpoint that Google has since removed entirely - every
// method on it now 404s, not just dailyTrends - so this talks to the RSS
// feed directly instead.) The fallback list keeps the pipeline running
// if this breaks too.
const TRENDS_RSS_URL = 'https://trends.google.com/trending/rss';

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
    const res = await fetch(`${TRENDS_RSS_URL}?geo=${encodeURIComponent(geo)}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const xml = await res.text();
    const titles = [...xml.matchAll(/<item>[\s\S]*?<title>([^<]+)<\/title>/g)].map(m => m[1].trim());
    if (!titles.length) throw new Error('no <item> titles found in RSS feed');

    return titles.slice(0, 20);
  } catch (err) {
    console.warn('[trends] Google Trends RSS failed, using fallback seeds:', err.message);
    return FALLBACK_SEEDS;
  }
}

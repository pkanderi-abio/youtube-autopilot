// Thin wrapper around Pexels' free stock-video search API - real b-roll
// footage instead of AI-generated stills/gradients. Needs a free
// registered API key (https://www.pexels.com/api/), same pattern as the
// YouTube Data API key this project already requires for uploads - no
// paid tier involved.
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const PEXELS_SEARCH_URL = 'https://api.pexels.com/videos/search';

// How many of Pexels' top-ranked results are treated as "equally good
// enough" to pick from at random. Always taking result #1 meant any two
// videos with the same (or a similarly generic) scene search phrase -
// very common on channel2, where lots of topics generate a scene like
// "baby playing with toys" - downloaded the literal same clip every
// time, producing near-identical thumbnails/backgrounds across
// unrelated videos (confirmed directly: 5 of 6 recent channel2 uploads
// shared the same background frame). Randomizing across the top N
// still-relevant results breaks that without picking something
// off-topic. Set to 15 (out of PAGE_SIZE=20 fetched) rather than a
// smaller number - a channel publishing 40+ videos off a handful of
// recurring generic queries needs real headroom, or the same small
// pool just gets picked from repeatedly again (pigeonhole principle:
// 40 draws from a pool of 5 guarantees heavy repeats).
const PAGE_SIZE = 20;
const RESULT_POOL_SIZE = 15;

// Finds a stock clip matching `query` and downloads it, returning the
// local file path. Picks the smallest available file that still meets
// the target resolution - Pexels also offers 4K masters we don't need
// when encoding down to 1080p, so grabbing those would just waste
// bandwidth and download time for no visible quality gain.
export async function findStockFootageClip(query, { width, height }) {
  if (!PEXELS_API_KEY) {
    throw new Error('Missing PEXELS_API_KEY (free key from https://www.pexels.com/api/)');
  }

  const orientation = height > width ? 'portrait' : 'landscape';
  const url = `${PEXELS_SEARCH_URL}?query=${encodeURIComponent(query)}&per_page=${PAGE_SIZE}&orientation=${orientation}`;
  const response = await fetch(url, { headers: { Authorization: PEXELS_API_KEY } });
  if (!response.ok) {
    throw new Error(`Pexels search failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const pool = (data.videos || []).slice(0, RESULT_POOL_SIZE);
  const video = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null;
  if (!video) {
    throw new Error(`no Pexels results for query: "${query}"`);
  }

  const candidates = (video.video_files || [])
    .filter((f) => f.file_type === 'video/mp4' && f.width && f.height)
    .sort((a, b) => (a.width * a.height) - (b.width * b.height));
  const file = candidates.find((f) => f.width >= width && f.height >= height) || candidates[candidates.length - 1];
  if (!file) {
    throw new Error(`no usable video file for query: "${query}"`);
  }

  const videoResponse = await fetch(file.link);
  if (!videoResponse.ok) {
    throw new Error(`Pexels video download failed: ${videoResponse.status}`);
  }
  return Buffer.from(await videoResponse.arrayBuffer());
}

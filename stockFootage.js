// Thin wrapper around Pexels' free stock-video search API - real b-roll
// footage instead of AI-generated stills/gradients. Needs a free
// registered API key (https://www.pexels.com/api/).
//
// Selection strategy changed: the previous version picked at RANDOM from
// the top 15 results to avoid downloading the same clip repeatedly. That
// traded relevance away to solve a duplication problem - result #15 for a
// query is often only loosely related, which is a direct cause of footage
// that doesn't match the narration.
//
// Now: relevance first, de-duplication second. Walk results in Pexels'
// own ranked order and take the FIRST one whose id hasn't been used
// recently by this channel. Duplication is prevented by remembering what
// was actually used (persisted in history.usedClipIds) rather than by
// throwing a dart at the result list. Only if every ranked result has
// been used recently do we fall back to the best-ranked one anyway -
// repeating a well-matched clip beats showing an unrelated one.
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const PEXELS_SEARCH_URL = 'https://api.pexels.com/videos/search';

const PAGE_SIZE = 20;

// Finds a stock clip matching `query` and downloads it. Returns
// { buffer, clipId, usedQuery } so the caller can record the id and
// avoid reusing the same clip on later videos.
// usedClipIds: array of Pexels video ids already used recently.
export async function findStockFootageClip(query, { width, height, usedClipIds = [] }) {
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
  const results = data.videos || [];
  if (!results.length) {
    throw new Error(`no Pexels results for query: "${query}"`);
  }

  const used = new Set(usedClipIds.map(String));
  const fresh = results.find((v) => !used.has(String(v.id)));
  const video = fresh || results[0];
  if (!fresh) {
    console.warn(`[footage] every ranked result for "${query}" was used recently - reusing best match #${video.id} rather than picking something off-topic`);
  }

  const rank = results.indexOf(video) + 1;
  console.log(`[footage] "${query}" -> Pexels #${video.id} (rank ${rank}/${results.length})`);

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
  return {
    buffer: Buffer.from(await videoResponse.arrayBuffer()),
    clipId: String(video.id),
    usedQuery: query
  };
}

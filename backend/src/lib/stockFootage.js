// Thin wrapper around Pexels' free stock-video search API - real b-roll
// footage instead of AI-generated stills/gradients. Needs a free
// registered API key (https://www.pexels.com/api/), same pattern as the
// YouTube Data API key this project already requires for uploads - no
// paid tier involved.
const PEXELS_API_KEY = process.env.PEXELS_API_KEY;
const PEXELS_SEARCH_URL = 'https://api.pexels.com/videos/search';

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
  const url = `${PEXELS_SEARCH_URL}?query=${encodeURIComponent(query)}&per_page=10&orientation=${orientation}`;
  const response = await fetch(url, { headers: { Authorization: PEXELS_API_KEY } });
  if (!response.ok) {
    throw new Error(`Pexels search failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();
  const video = data.videos?.[0];
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

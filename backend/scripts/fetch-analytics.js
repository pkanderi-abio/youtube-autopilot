// Pulls real view/like/comment counts for every published video via the
// YouTube Data API (videos.list, part=statistics) and writes
// data/analytics-<channelId>.json. This is the analytics-feedback-loop
// piece the pipeline otherwise lacked entirely (see frontend's old
// revenueNote: "this pipeline has no YouTube Analytics integration").
//
// Runs on its own daily schedule (.github/workflows/analytics.yml), not
// as part of run-pipeline.js - it's read-only, auxiliary, and shouldn't
// affect (or be affected by) the publish path's fail-loud behavior. Uses
// the SAME OAuth refresh tokens already used for uploads: get-refresh-
// token.js requests the full 'youtube' scope (not just '.upload'), which
// already covers reading statistics on the channel's own videos, so no
// new consent/credential is required.
import 'dotenv/config';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { getYoutubeClient } from '../src/lib/youtube.js';

const DATA_DIR = path.resolve('data');
const BATCH_SIZE = 50; // videos.list max ids per call

function videoIdFromUrl(url) {
  const m = url.match(/(?:youtu\.be\/|[?&]v=)([\w-]{6,})/);
  return m ? m[1] : null;
}

async function fetchStatsForChannel(channel) {
  const historyPath = path.join(DATA_DIR, `history-${channel.id}.json`);
  if (!existsSync(historyPath)) {
    console.log(`[analytics] no history yet for ${channel.id}, skipping`);
    return null;
  }
  const history = JSON.parse(await readFile(historyPath, 'utf8'));
  if (!history.videos?.length) return null;

  const youtube = getYoutubeClient(channel);
  const idToVideo = new Map();
  for (const v of history.videos) {
    const id = videoIdFromUrl(v.url);
    if (id) idToVideo.set(id, v);
  }
  const ids = [...idToVideo.keys()];

  const statsById = new Map();
  for (let i = 0; i < ids.length; i += BATCH_SIZE) {
    const batch = ids.slice(i, i + BATCH_SIZE);
    const res = await youtube.videos.list({ part: ['statistics'], id: batch });
    for (const item of res.data.items || []) {
      statsById.set(item.id, {
        viewCount: Number(item.statistics?.viewCount || 0),
        likeCount: Number(item.statistics?.likeCount || 0),
        commentCount: Number(item.statistics?.commentCount || 0)
      });
    }
  }

  const videos = [...idToVideo.entries()].map(([id, v]) => ({
    url: v.url,
    title: v.title,
    format: v.format || null,
    publishedAt: v.publishedAt,
    sourcePoolItem: v.sourcePoolItem || null,
    ...(statsById.get(id) || { viewCount: 0, likeCount: 0, commentCount: 0 })
  }));

  return { fetchedAt: new Date().toISOString(), videos };
}

async function main() {
  const channels = JSON.parse(await readFile(path.resolve('config/channels.json'), 'utf8')).channels;
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });

  for (const channel of channels) {
    try {
      const result = await fetchStatsForChannel(channel);
      if (!result) continue;
      await writeFile(path.join(DATA_DIR, `analytics-${channel.id}.json`), JSON.stringify(result, null, 2));
      const totalViews = result.videos.reduce((sum, v) => sum + v.viewCount, 0);
      const totalLikes = result.videos.reduce((sum, v) => sum + v.likeCount, 0);
      console.log(`[analytics] ${channel.id}: ${result.videos.length} videos, ${totalViews} views, ${totalLikes} likes`);
    } catch (err) {
      // Best-effort per channel - one channel's auth/quota problem
      // shouldn't block the other channel's stats from refreshing.
      console.warn(`[analytics] failed for ${channel.id}:`, err.message);
    }
  }
}

main();

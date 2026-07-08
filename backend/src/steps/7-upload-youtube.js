// Step 7 - upload the finished video (+ thumbnail) to YouTube via the
// Data API v3, using the channel's stored OAuth refresh token.
import { getYoutubeClient } from '../lib/youtube.js';
import { createReadStream } from 'fs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Observed directly in production: thumbnails.set failed once right
// after a successful videos.insert with "The thumbnail can't be set for
// the specified video. The request might not be properly authorized" -
// then succeeded immediately on a manual retry a few minutes later with
// the exact same credentials/scopes, meaning it was a transient timing
// issue (the video likely wasn't fully registered yet), not a real
// permissions problem. Retries a few times before giving up.
async function setThumbnailWithRetry(youtube, videoId, thumbnailPath) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await youtube.thumbnails.set({
        videoId,
        media: { body: createReadStream(thumbnailPath) }
      });
      return;
    } catch (error) {
      lastError = error;
      if (attempt < 2) await sleep(5000 * (attempt + 1));
    }
  }
  throw lastError;
}

export async function uploadToYoutube(channel, { videoPath, thumbnailPath, title, description, tags, hashtags = [] }) {
  const youtube = getYoutubeClient(channel);
  const finalDescription = hashtags.length
    ? `${description}\n\n${hashtags.join(' ')}`
    : description;

  const res = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title,
        description: finalDescription,
        tags,
        categoryId: channel.categoryId
      },
      status: {
        privacyStatus: 'public',
        selfDeclaredMadeForKids: Boolean(channel.madeForKids)
      }
    },
    media: {
      body: createReadStream(videoPath)
    }
  });

  const videoId = res.data.id;

  // The video is already live at this point - a thumbnail failure is
  // real but strictly less bad than losing this upload from history
  // entirely (which is what happened in production before this fix: the
  // whole run aborted here, so run-pipeline.js's history save never ran
  // and the published video was orphaned from tracking). Warn and move
  // on rather than throw.
  if (thumbnailPath) {
    try {
      await setThumbnailWithRetry(youtube, videoId, thumbnailPath);
    } catch (error) {
      console.warn(`[upload] thumbnail set failed after retries for ${videoId}, keeping default thumbnail:`, error.message);
    }
  }

  return { videoId, url: `https://youtu.be/${videoId}` };
}

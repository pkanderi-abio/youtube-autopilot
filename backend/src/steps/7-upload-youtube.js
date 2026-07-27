// Step 7 - upload the finished video (+ thumbnail) to YouTube via the
// Data API v3, using the channel's stored OAuth refresh token.
// Also handles two post-upload growth actions when configured:
//   1. Add the video to a channel-scoped playlist (session watch time
//      boost, the biggest YouTube algo signal - playlists chain viewers
//      into the next video which grows watch-hours)
//   2. Post a first comment from the channel owner with a CTA
//      (engagement signal - YouTube pinning is NOT available via the
//      Data API as of 2026, but a fresh video's first comment still
//      appears at the top of the section)
// Both are best-effort - if either fails, the video is already live so
// we warn and move on rather than dying and losing history tracking.
import { getYoutubeClient } from '../lib/youtube.js';
import { createReadStream } from 'fs';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

// Add the fresh video to the channel's configured playlist. Playlist
// membership is what tells YouTube's algo "these videos should be
// recommended together as a session" - the single biggest lever we
// have for growing watch-hours per viewer. Playlist ID must exist
// (create it once in YouTube Studio and paste the PL... ID into
// channels.json). Costs 50 quota units.
async function addToPlaylist(youtube, videoId, playlistId) {
  await youtube.playlistItems.insert({
    part: ['snippet'],
    requestBody: {
      snippet: {
        playlistId,
        resourceId: { kind: 'youtube#video', videoId }
      }
    }
  });
}

// Posts a first top-level comment from the channel owner. Not pinned
// (the Data API doesn't expose comment pinning as of 2026 - feature
// request open, unshipped), but a fresh video's first comment is
// still visible near the top of the comment section. The comment
// text is a CTA-flavored line generated as part of step 2's script,
// falling back to a generic invite if the script didn't produce one.
// Costs 50 quota units.
async function postFirstComment(youtube, videoId, commentText) {
  await youtube.commentThreads.insert({
    part: ['snippet'],
    requestBody: {
      snippet: {
        videoId,
        topLevelComment: {
          snippet: {
            textOriginal: commentText
          }
        }
      }
    }
  });
}

function defaultCta(channel) {
  if (channel.madeForKids) {
    // NB: comments are DISABLED on kids content. postFirstComment will
    // fail with a 403; we still try (some Studio settings vary) but the
    // outer try/catch swallows it.
    return `More sing-alongs for little ones coming up! 🎵`;
  }
  return `Which one surprised you the most? 👀 Drop it in the replies — and hit subscribe for more like this every day.`;
}

export async function uploadToYoutube(channel, { videoPath, thumbnailPath, title, description, tags, hashtags = [], commentCta }) {
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

  // Video is live. All remaining steps are best-effort - a failure
  // here would previously have orphaned an already-published video
  // from our history log (real prior incident), so every one is
  // warn-and-continue.
  if (thumbnailPath) {
    try {
      await setThumbnailWithRetry(youtube, videoId, thumbnailPath);
    } catch (error) {
      console.warn(`[upload] thumbnail set failed after retries for ${videoId}, keeping default thumbnail:`, error.message);
    }
  }

  if (channel.playlistId) {
    try {
      await addToPlaylist(youtube, videoId, channel.playlistId);
      console.log(`[upload] added ${videoId} to playlist ${channel.playlistId}`);
    } catch (error) {
      console.warn(`[upload] playlist add failed for ${videoId} (playlist ${channel.playlistId}):`, error.message);
    }
  }

  // First-comment: skip for madeForKids channels where comments are
  // API-blocked anyway (would just throw 403).
  if (!channel.madeForKids) {
    try {
      const text = commentCta || defaultCta(channel);
      await postFirstComment(youtube, videoId, text);
      console.log(`[upload] posted first comment on ${videoId}`);
    } catch (error) {
      console.warn(`[upload] first comment failed on ${videoId}:`, error.message);
    }
  }

  return { videoId, url: `https://youtu.be/${videoId}` };
}

// Step 7 - upload the finished video (+ thumbnail) to YouTube via the
// Data API v3, using the channel's stored OAuth refresh token.
import { getYoutubeClient } from '../lib/youtube.js';
import { createReadStream } from 'fs';

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

  if (thumbnailPath) {
    await youtube.thumbnails.set({
      videoId,
      media: { body: createReadStream(thumbnailPath) }
    });
  }

  return { videoId, url: `https://youtu.be/${videoId}` };
}

// Step 7 - upload the finished video (+ thumbnail) to YouTube via the
// Data API v3, using the channel's stored OAuth refresh token.
import { getYoutubeClient } from '../lib/youtube.js';
import { createReadStream } from 'fs';

export async function uploadToYoutube(channel, { videoPath, thumbnailPath, title, description, tags }) {
  const youtube = getYoutubeClient(channel);

  const res = await youtube.videos.insert({
    part: ['snippet', 'status'],
    requestBody: {
      snippet: {
        title,
        description,
        tags,
        categoryId: channel.categoryId
      },
      status: {
        privacyStatus: 'public',
        selfDeclaredMadeForKids: false
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

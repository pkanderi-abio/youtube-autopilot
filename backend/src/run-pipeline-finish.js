// "Finish" stage for channels whose image generation is split across
// parallel CI jobs (see run-pipeline-prepare.js and generate-scene-cli.js
// for why). Picks up the script/voice written by the prepare stage plus
// whatever scene images the parallel jobs managed to produce, then runs
// steps 4-7 (background, assembly, thumbnail, upload) exactly like
// run-pipeline.js does for channel1.
// Usage: node src/run-pipeline-finish.js <channelId> <prepDir> <imagesDir>
import 'dotenv/config';
import { mkdtemp, rm, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

import { loadHistory, saveHistory } from './lib/state.js';
import { generateBackground } from './steps/4-generate-background.js';
import { assembleVideo } from './steps/5-assemble-video.js';
import { generateThumbnail } from './steps/6-generate-thumbnail.js';
import { uploadToYoutube } from './steps/7-upload-youtube.js';

async function run(channelId, prepDir, imagesDir) {
  const channels = JSON.parse(await readFile(path.resolve('config/channels.json'), 'utf8')).channels;
  const channel = channels.find(c => c.id === channelId);
  if (!channel) throw new Error(`Unknown channel id: ${channelId}`);

  const script = JSON.parse(await readFile(path.join(prepDir, 'script.json'), 'utf8'));
  const audioPath = path.join(prepDir, 'voice.mp3');

  console.log(`[finish] starting for ${channel.name} (${channel.id})`);
  const history = await loadHistory(channel.id);
  const workDir = await mkdtemp(path.join(tmpdir(), `autopilot-${channel.id}-`));

  try {
    const scenes = script.scenes || [];
    const pregeneratedImages = scenes.map((_, i) => {
      const p = path.join(imagesDir, `scene-${i}.png`);
      return existsSync(p) ? p : null;
    });
    const generatedCount = pregeneratedImages.filter(Boolean).length;
    console.log(`[4/7] generating background video... (${generatedCount}/${scenes.length} scene images ready)`);
    const backgroundPath = await generateBackground(channel, script.duration, workDir, scenes, pregeneratedImages);

    console.log('[5/7] assembling final video...');
    const videoPath = await assembleVideo({
      backgroundPath, audioPath, captionLines: script.captionLines, workDir
    });

    console.log('[6/7] generating thumbnail...');
    const thumbnailPath = await generateThumbnail(channel, script.title, workDir);

    console.log('[7/7] uploading to YouTube...');
    const upload = await uploadToYoutube(channel, {
      videoPath, thumbnailPath,
      title: script.title,
      description: script.description,
      tags: script.tags,
      hashtags: script.hashtags || []
    });
    console.log('   -> published:', upload.url);

    history.usedTopics.push(script.topic);
    history.videos.push({
      title: script.title, url: upload.url, publishedAt: new Date().toISOString()
    });
    await saveHistory(channel.id, history);

    console.log(`[finish] done: ${upload.url}`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

const [channelId, prepDir, imagesDir] = process.argv.slice(2);
if (!channelId || !prepDir || !imagesDir) {
  console.error('Usage: node src/run-pipeline-finish.js <channelId> <prepDir> <imagesDir>');
  process.exit(1);
}
run(channelId, prepDir, imagesDir).catch((err) => {
  console.error('[finish] FAILED:', err);
  process.exit(1);
});

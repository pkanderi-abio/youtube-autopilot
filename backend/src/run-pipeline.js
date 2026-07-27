// Orchestrator - chains steps 1-7 for a single channel, end to end.
// Usage: node src/run-pipeline.js <channelId> [format]
// format ("short" | "long") overrides the channel's default - each
// channel can publish both a short and a long-form video, sharing one
// history/usedTopics list so topics never repeat across formats.
import 'dotenv/config';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { readFile } from 'fs/promises';

import { loadHistory, saveHistory } from './lib/state.js';
import { resolveNurseryAudio, prepareNurseryAudio, NURSERY_TARGET_DURATION } from './lib/nurseryAudio.js';
import { discoverTopic } from './steps/1-discover-topic.js';
import { generateScript } from './steps/2-generate-script.js';
import { generateVoice } from './steps/3-generate-voice.js';
import { generateBackground } from './steps/4-generate-background.js';
import { assembleVideo } from './steps/5-assemble-video.js';
import { generateThumbnail } from './steps/6-generate-thumbnail.js';
import { uploadToYoutube } from './steps/7-upload-youtube.js';

async function ffprobeDuration(file) {
  const ffmpeg = (await import('fluent-ffmpeg')).default;
  const ffprobePath = (await import('ffprobe-static')).default;
  ffmpeg.setFfprobePath(ffprobePath.path);
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, data) => err ? reject(err) : resolve(data.format.duration));
  });
}

async function run(channelId, formatOverride) {
  const channels = JSON.parse(await readFile(path.resolve('config/channels.json'), 'utf8')).channels;
  const baseChannel = channels.find(c => c.id === channelId);
  if (!baseChannel) throw new Error(`Unknown channel id: ${channelId}`);
  if (formatOverride && !['short', 'long'].includes(formatOverride)) {
    throw new Error(`Invalid format: ${formatOverride} (expected "short" or "long")`);
  }
  const channel = formatOverride ? { ...baseChannel, format: formatOverride } : baseChannel;

  console.log(`[pipeline] starting run for ${channel.name} (${channel.id}, ${channel.format})`);
  const history = await loadHistory(channel.id);
  const workDir = await mkdtemp(path.join(tmpdir(), `autopilot-${channel.id}-`));

  try {
    console.log('[1/7] discovering topic...');
    const topicInfo = await discoverTopic(channel, history);
    console.log('   ->', topicInfo.topic);

    // Nursery-audio check runs BEFORE the script step so we can skip
    // narration generation entirely when we already have real singing
    // audio for this topic - long-form baby videos otherwise burn
    // ~5min of Ollama on section-by-section narration text we'd throw
    // away.
    const nursery = await resolveNurseryAudio(topicInfo.topic);

    console.log('[2/7] generating script...');
    const script = await generateScript(channel, topicInfo, { skipNarration: !!nursery });
    console.log('   ->', script.title);

    console.log('[3/7] generating voiceover...');
    const audioPath = path.join(workDir, 'voice.mp3');
    if (nursery) {
      // Real sung public-domain recording matched this topic. Use it
      // instead of Edge TTS reading lyrics as spoken text (which is
      // what babies/toddlers do NOT engage with).
      const target = NURSERY_TARGET_DURATION[channel.format] || NURSERY_TARGET_DURATION.short;
      console.log(`   -> using bundled recording: ${nursery.filename} (${nursery.license})`);
      await prepareNurseryAudio(nursery, audioPath, target);
    } else {
      await generateVoice(script.narration, audioPath, channel.voice);
    }

    const duration = await ffprobeDuration(audioPath);

    console.log('[4/7] generating background video...');
    const backgroundPath = await generateBackground(channel, duration, workDir, script.scenes || []);

    console.log('[5/7] assembling final video...');
    const videoPath = await assembleVideo({
      backgroundPath, audioPath, workDir
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

    history.usedTopics.push(topicInfo.topic);
    history.videos.push({
      title: script.title, url: upload.url, format: channel.format, publishedAt: new Date().toISOString()
    });
    await saveHistory(channel.id, history);

    console.log(`[pipeline] done: ${upload.url}`);
  } finally {
    await rm(workDir, { recursive: true, force: true });
  }
}

const [channelId, formatOverride] = process.argv.slice(2);
if (!channelId) {
  console.error('Usage: node src/run-pipeline.js <channelId> [format]');
  process.exit(1);
}
run(channelId, formatOverride).catch((err) => {
  console.error('[pipeline] FAILED:', err);
  process.exit(1);
});

// Orchestrator - chains steps 1-8 for a single channel, end to end.
// Usage: node src/run-pipeline.js <channelId> [format]
// format ("short" | "long") overrides the channel's default - each
// channel can publish both a short and a long-form video, sharing one
// history/usedTopics list so topics never repeat across formats.
import 'dotenv/config';
import { mkdtemp, rm, mkdir, copyFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { readFile } from 'fs/promises';

import { loadHistory, saveHistory } from './lib/state.js';
import { resolveNurseryAudio, prepareNurseryAudio, NURSERY_TARGET_DURATION } from './lib/nurseryAudio.js';
import { discoverTopic } from './steps/1-discover-topic.js';
import { generateScript } from './steps/2-generate-script.js';
import { optimizeSeo } from './steps/3-optimize-seo.js';
import { generateVoice } from './steps/4-generate-voice.js';
import { generateBackground } from './steps/5-generate-background.js';
import { assembleVideo } from './steps/6-assemble-video.js';
import { generateThumbnail } from './steps/7-generate-thumbnail.js';
import { uploadToYoutube } from './steps/8-upload-youtube.js';

const THUMBNAIL_VARIANTS_DIR = path.resolve('data', 'thumbnail-variants');

async function ffprobeDuration(file) {
  const ffmpeg = (await import('fluent-ffmpeg')).default;
  const ffprobePath = (await import('ffprobe-static')).default;
  ffmpeg.setFfprobePath(ffprobePath.path);
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, data) => err ? reject(err) : resolve(data.format.duration));
  });
}

// Best-effort: the video is already live by the time this runs, so a
// failure here should never fail the pipeline - same "warn and move on"
// philosophy as the thumbnail-set/playlist/first-comment steps in step 8.
async function saveThumbnailVariants(channelId, videoId, thumbnail) {
  try {
    const dir = path.join(THUMBNAIL_VARIANTS_DIR, channelId);
    await mkdir(dir, { recursive: true });
    await copyFile(thumbnail.primary, path.join(dir, `${videoId}-A.png`));
    await copyFile(thumbnail.variantB, path.join(dir, `${videoId}-B.png`));
    console.log(`   -> saved thumbnail variants to data/thumbnail-variants/${channelId}/${videoId}-{A,B}.png`);
  } catch (err) {
    console.warn('[pipeline] failed to save thumbnail variants (non-fatal):', err.message);
  }
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
    console.log('[1/8] discovering topic...');
    const topicInfo = await discoverTopic(channel, history);
    console.log('   ->', topicInfo.topic);

    // Nursery-audio check runs BEFORE the script step so we can skip
    // narration generation entirely when we already have real singing
    // audio for this topic - long-form baby videos otherwise burn
    // ~5min of Ollama on section-by-section narration text we'd throw
    // away.
    const nursery = await resolveNurseryAudio(topicInfo.topic);

    console.log('[2/8] generating script...');
    const script = await generateScript(channel, topicInfo, { skipNarration: !!nursery });

    console.log('[3/8] optimizing SEO metadata...');
    const seo = await optimizeSeo(channel, topicInfo, script, history);
    console.log('   ->', seo.title);

    console.log('[4/8] generating voiceover...');
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

    console.log('[5/8] generating background video...');
    const backgroundPath = await generateBackground(channel, duration, workDir, script.scenes || []);

    console.log('[6/8] assembling final video...');
    const videoPath = await assembleVideo({
      backgroundPath, audioPath, workDir
    });

    console.log('[7/8] generating thumbnail...');
    const thumbnail = await generateThumbnail(channel, seo.title, workDir);

    console.log('[8/8] uploading to YouTube...');
    const upload = await uploadToYoutube(channel, {
      videoPath, thumbnailPath: thumbnail.primary,
      title: seo.title,
      description: seo.description,
      tags: seo.tags,
      hashtags: seo.hashtags || [],
      commentCta: seo.commentCta || ''
    });
    console.log('   -> published:', upload.url);

    await saveThumbnailVariants(channel.id, upload.videoId, thumbnail);

    history.usedTopics.push(topicInfo.topic);
    history.videos.push({
      title: seo.title, url: upload.url, format: channel.format, publishedAt: new Date().toISOString(),
      ...(topicInfo.sourcePoolItem ? { sourcePoolItem: topicInfo.sourcePoolItem } : {})
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

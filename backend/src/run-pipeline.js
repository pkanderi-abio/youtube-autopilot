// Orchestrator: one fully AI-generated video for one (channel, format).
//   node src/run-pipeline.js <channelId> [short|long] [--dry-run] [--topic="..."]
// --dry-run (or DRY_RUN=1) renders everything but skips the YouTube upload
// and history update; output lands in backend/out/. Combine with MOCK_AI=1
// to run fully offline with placeholder AI.
//
// Log markers "[N/8] ...", "-> ..." and "published:" are parsed by
// frontend/build-data.js - keep their shape.
import 'dotenv/config';
import { mkdtemp, rm, mkdir, copyFile, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';

import { loadHistory, saveHistory } from './lib/state.js';
import { resolveNurseryAudio, NURSERY_TARGET_DURATION } from './lib/nurseryAudio.js';
import { usage } from './lib/cloudflare.js';
import { MOCK } from './lib/llm.js';
import { discoverTopic } from './steps/1-topic.js';
import { generateScript } from './steps/2-script.js';
import { optimizeSeo } from './steps/3-seo.js';
import { generateVoice } from './steps/4-voice.js';
import { generateVisuals } from './steps/5-visuals.js';
import { renderVideo } from './steps/6-render.js';
import { generateThumbnail } from './steps/7-thumbnail.js';
import { uploadToYoutube } from './steps/8-upload.js';

const SECONDS_PER_SUNG_SCENE = 6;

async function loadChannel(channelId, formatOverride) {
  const { channels } = JSON.parse(await readFile(path.resolve('config/channels.json'), 'utf8'));
  const base = channels.find((c) => c.id === channelId);
  if (!base) throw new Error(`Unknown channel id: ${channelId}`);
  if (formatOverride && !['short', 'long'].includes(formatOverride)) {
    throw new Error(`Invalid format "${formatOverride}" (expected short | long)`);
  }
  const format = formatOverride || base.format;
  // per-format overrides: "formats": { "long": { "captions": false } }
  return { ...base, ...(base.formats?.[format] || {}), format };
}

async function run(channelId, formatOverride, dryRun, topicArg) {
  const channel = await loadChannel(channelId, formatOverride);
  console.log(`[pipeline] ${channel.name} (${channel.id}, ${channel.format})${dryRun ? ' DRY RUN' : ''}${MOCK ? ' MOCK AI' : ''}`);
  const history = await loadHistory(channel.id);
  const workDir = await mkdtemp(path.join(tmpdir(), `autopilot-${channel.id}-`));
  const started = Date.now();

  try {
    console.log('[1/8] discovering topic...');
    // TOPIC="..." (or --topic=...) forces a specific topic, e.g. for a manual run.
    const forced = topicArg || process.env.TOPIC;
    const topicInfo = forced
      ? { topic: forced, angle: '', sourcePoolItem: channel.topicPool?.includes(forced) ? forced : null, trend: null }
      : await discoverTopic(channel, history);
    console.log('   ->', topicInfo.topic);

    const nursery = channel.contentStyle === 'babyLearning' ? await resolveNurseryAudio(topicInfo.sourcePoolItem) : null;

    console.log('[2/8] generating script...');
    const sungSceneCount = nursery
      ? Math.round((NURSERY_TARGET_DURATION[channel.format] || 50) / SECONDS_PER_SUNG_SCENE)
      : 0;
    const script = await generateScript(channel, topicInfo, { sungSceneCount });
    console.log(`   -> ${script.scenes.length} scenes${script.narration ? `, ${script.narration.split(/\s+/).length} words` : ' (sung track)'}`);

    console.log('[3/8] optimizing SEO...');
    const seo = await optimizeSeo(channel, topicInfo, script, history);
    console.log('   ->', seo.title);

    console.log('[4/8] generating voiceover...');
    const voice = await generateVoice(channel, script, workDir, { nursery });
    console.log(`   -> ${voice.duration.toFixed(1)}s via ${voice.provider}`);
    if (channel.format === 'short' && voice.duration > 175) {
      throw new Error(`short is ${voice.duration.toFixed(0)}s - over the 3-minute Shorts limit`);
    }

    console.log('[5/8] generating AI visuals...');
    const visuals = await generateVisuals(channel, script, workDir);
    console.log(`   -> ${script.scenes.length} images (${Object.entries(visuals.providers).map(([k, v]) => `${k}:${v}`).join(', ')}), ${visuals.clips} AI clips`);

    console.log('[6/8] rendering video...');
    const videoPath = await renderVideo(channel, script, voice.audioPath, workDir);
    console.log('   -> rendered', path.basename(videoPath));

    console.log('[7/8] generating thumbnail...');
    const thumbnail = await generateThumbnail(channel, script, seo, workDir);
    console.log('   ->', seo.thumbnailText || '(title words)');

    const outDir = path.resolve('out', channel.id);
    await mkdir(outDir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');

    if (dryRun) {
      console.log('[8/8] upload skipped (dry run)...');
      await copyFile(videoPath, path.join(outDir, `${stamp}-${channel.format}.mp4`));
      await copyFile(thumbnail.primary, path.join(outDir, `${stamp}-${channel.format}-thumb-A.jpg`));
      await copyFile(thumbnail.variantB, path.join(outDir, `${stamp}-${channel.format}-thumb-B.jpg`));
      await writeFile(path.join(outDir, `${stamp}-${channel.format}.json`), JSON.stringify({ topicInfo, seo, script }, null, 2));
      console.log(`   -> saved to out/${channel.id}/${stamp}-${channel.format}.mp4`);
    } else {
      console.log('[8/8] uploading to YouTube...');
      const upload = await uploadToYoutube(channel, {
        videoPath, thumbnailPath: thumbnail.primary,
        title: seo.title, description: seo.description, tags: seo.tags,
        hashtags: seo.hashtags || [], commentCta: seo.commentCta || ''
      });
      console.log('   -> published:', upload.url);
      // thumbnail variants are uploaded as a CI artifact (never committed)
      await copyFile(thumbnail.primary, path.join(outDir, `${upload.videoId}-A.jpg`));
      await copyFile(thumbnail.variantB, path.join(outDir, `${upload.videoId}-B.jpg`));

      history.usedTopics.push(topicInfo.trend || topicInfo.topic);
      history.videos.push({
        title: seo.title, url: upload.url, format: channel.format, publishedAt: new Date().toISOString(),
        ...(topicInfo.sourcePoolItem ? { sourcePoolItem: topicInfo.sourcePoolItem } : {})
      });
      await saveHistory(channel.id, history);
    }

    console.log(`[pipeline] done in ${((Date.now() - started) / 1000).toFixed(0)}s, ~${Math.round(usage.neurons)} Cloudflare neurons (free: 10,000/day)`);
  } finally {
    if (process.env.KEEP_WORKDIR === '1') console.log(`[pipeline] work dir kept: ${workDir}`);
    else await rm(workDir, { recursive: true, force: true });
  }
}

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run') || process.env.DRY_RUN === '1';
const [channelId, formatOverride] = args.filter((a) => !a.startsWith('--'));
const topicArg = args.find((a) => a.startsWith('--topic='))?.slice('--topic='.length);
if (!channelId) {
  console.error('Usage: node src/run-pipeline.js <channelId> [short|long] [--dry-run]');
  process.exit(1);
}
run(channelId, formatOverride, dryRun, topicArg).catch((err) => {
  console.error('[pipeline] FAILED:', err.message || err);
  if (err.stack) console.error(err.stack);
  process.exit(1);
});

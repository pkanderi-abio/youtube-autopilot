// "Prepare" stage for channels whose image generation is split across
// parallel CI jobs (self-hosted Stable Diffusion is too slow to
// generate 8-14 scenes serially in one job - see
// .github/workflows/pipeline.yml). Runs steps 1-3 (topic, script, voice)
// and writes everything the parallel image jobs and the "finish" stage
// need to a directory, instead of continuing straight through to
// background/assembly/upload like run-pipeline.js does for channel1.
// Usage: node src/run-pipeline-prepare.js <channelId> <outDir>
import 'dotenv/config';
import { mkdir, writeFile, appendFile, readFile } from 'fs/promises';
import path from 'path';

import { loadHistory } from './lib/state.js';
import { discoverTopic } from './steps/1-discover-topic.js';
import { generateScript } from './steps/2-generate-script.js';
import { generateVoice } from './steps/3-generate-voice.js';

async function ffprobeDuration(file) {
  const ffmpeg = (await import('fluent-ffmpeg')).default;
  const ffprobePath = (await import('ffprobe-static')).default;
  ffmpeg.setFfprobePath(ffprobePath.path);
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(file, (err, data) => err ? reject(err) : resolve(data.format.duration));
  });
}

async function run(channelId, outDir) {
  const channels = JSON.parse(await readFile(path.resolve('config/channels.json'), 'utf8')).channels;
  const channel = channels.find(c => c.id === channelId);
  if (!channel) throw new Error(`Unknown channel id: ${channelId}`);

  await mkdir(outDir, { recursive: true });

  console.log(`[prepare] starting for ${channel.name} (${channel.id})`);
  const history = await loadHistory(channel.id);

  console.log('[1/3] discovering topic...');
  const topicInfo = await discoverTopic(channel, history);
  console.log('   ->', topicInfo.topic);

  console.log('[2/3] generating script...');
  const script = await generateScript(channel, topicInfo);
  console.log('   ->', script.title);

  console.log('[3/3] generating voiceover...');
  const audioPath = path.join(outDir, 'voice.mp3');
  await generateVoice(script.narration, audioPath);
  const duration = await ffprobeDuration(audioPath);

  await writeFile(path.join(outDir, 'script.json'), JSON.stringify({ ...script, topic: topicInfo.topic, duration }, null, 2));

  const sceneCount = script.scenes?.length || 0;
  console.log(`[prepare] done - ${sceneCount} scenes, ${duration.toFixed(1)}s narration`);

  if (process.env.GITHUB_OUTPUT) {
    const indices = Array.from({ length: sceneCount }, (_, i) => i);
    await appendFile(process.env.GITHUB_OUTPUT, `scene_count=${sceneCount}\nscene_indices=${JSON.stringify(indices)}\n`);
  }
}

const [channelId, outDir] = process.argv.slice(2);
if (!channelId || !outDir) {
  console.error('Usage: node src/run-pipeline-prepare.js <channelId> <outDir>');
  process.exit(1);
}
run(channelId, outDir).catch((err) => {
  console.error('[prepare] FAILED:', err);
  process.exit(1);
});

// Step 4 - AI voiceover, synthesized PER SCENE and concatenated, so each
// scene's on-screen duration is exactly the length of its own narration
// (plus a short breath). Sung-recording videos instead loop the bundled
// track and split its length evenly across the scenes.
import path from 'path';
import { writeFile } from 'fs/promises';
import { synthesize } from '../lib/tts.js';
import { ffmpeg, probeDuration } from '../lib/ffmpeg.js';
import { prepareNurseryAudio, NURSERY_TARGET_DURATION } from '../lib/nurseryAudio.js';

const PAUSE = 0.3; // seconds of silence after each scene

export async function generateVoice(channel, script, workDir, { nursery } = {}) {
  const out = path.join(workDir, 'voice.m4a');

  if (nursery) {
    const total = NURSERY_TARGET_DURATION[channel.format] || NURSERY_TARGET_DURATION.short;
    const mp3 = path.join(workDir, 'voice.mp3');
    await prepareNurseryAudio(nursery, mp3, total);
    await ffmpeg(['-i', mp3, '-c:a', 'aac', '-b:a', '160k', out]);
    const each = total / script.scenes.length;
    script.scenes.forEach((s) => { s.duration = each; });
    return { audioPath: out, duration: total, provider: `bundled:${nursery.filename}` };
  }

  const parts = [];
  const providers = new Set();
  for (const [i, scene] of script.scenes.entries()) {
    const file = path.join(workDir, `vo-${String(i).padStart(3, '0')}.mp3`);
    providers.add(await synthesize(scene.narration, file, { voice: channel.voice, rate: channel.voiceRate }));
    const padded = path.join(workDir, `vo-${String(i).padStart(3, '0')}.wav`);
    // normalise to one sample format and append the pause
    await ffmpeg(['-i', file, '-af', `apad=pad_dur=${PAUSE}`, '-ar', '24000', '-ac', '1', padded]);
    scene.duration = await probeDuration(padded);
    parts.push(padded);
  }

  const list = path.join(workDir, 'vo-list.txt');
  await writeFile(list, parts.map((p) => `file '${p}'`).join('\n'));
  await ffmpeg(['-f', 'concat', '-safe', '0', '-i', list,
    '-af', 'loudnorm=I=-16:TP=-1.5:LRA=11', '-ar', '48000', '-c:a', 'aac', '-b:a', '160k', out]);
  const duration = script.scenes.reduce((s, x) => s + x.duration, 0);
  return { audioPath: out, duration, provider: [...providers].join('+') };
}

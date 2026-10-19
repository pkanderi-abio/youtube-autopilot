// Free AI voice. Primary: Microsoft Edge neural TTS via msedge-tts (no key,
// best quality, unofficial endpoint). Backup: Cloudflare MeloTTS on the
// same free Workers AI account, so an Edge outage (the 2026-10-12 403
// incident paused channel1 for a week) no longer stops publishing.
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { writeFile } from 'fs/promises';
import { melotts, cloudflareConfigured } from './cloudflare.js';
import { ffmpeg } from './ffmpeg.js';
import { MOCK } from './llm.js';

const DEFAULT_VOICE = 'en-US-AndrewMultilingualNeural';
const DEFAULT_RATE = '-5%';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function edgeOnce(text, voice, rate) {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioStream } = tts.toStream(text, { rate });
  const chunks = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('edge tts timed out')), 60_000);
    audioStream.on('data', (c) => chunks.push(c));
    audioStream.on('end', () => { clearTimeout(timer); resolve(); });
    audioStream.on('error', (e) => { clearTimeout(timer); reject(e); });
  });
  tts.close?.();
  const buf = Buffer.concat(chunks);
  if (buf.length < 1000) throw new Error('edge tts returned empty audio');
  return buf;
}

let edgeDown = false;

// Writes speech for `text` to outPath (mp3). Returns the provider used.
export async function synthesize(text, outPath, { voice = DEFAULT_VOICE, rate = DEFAULT_RATE } = {}) {
  if (MOCK) {
    // ~2.6 spoken words/sec, as a quiet tone so timing is realistic offline.
    const seconds = Math.max(1.5, text.split(/\s+/).length / 2.6);
    await ffmpeg(['-f', 'lavfi', '-i', `sine=frequency=220:duration=${seconds.toFixed(2)}`,
      '-af', 'volume=0.05', '-c:a', 'libmp3lame', '-b:a', '64k', outPath]);
    return 'mock';
  }

  const errors = [];
  if (!edgeDown) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        await writeFile(outPath, await edgeOnce(text, voice, rate));
        return 'edge';
      } catch (error) {
        errors.push(`edge: ${error.message}`);
        await sleep(2000 * (attempt + 1));
      }
    }
    edgeDown = true; // don't spend 3 retries on every remaining scene
    console.warn(`[tts] Edge TTS failing (${errors.at(-1)}) - switching to Cloudflare MeloTTS`);
  }

  if (cloudflareConfigured()) {
    try {
      const raw = await melotts(text);
      const tmp = `${outPath}.raw`;
      await writeFile(tmp, raw);
      await ffmpeg(['-i', tmp, '-ar', '24000', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '64k', outPath]);
      return 'melotts';
    } catch (error) {
      errors.push(`melotts: ${error.message}`);
    }
  }
  throw new Error(`[tts] all voices failed:\n${errors.join('\n')}`);
}

// Toddler channels play REAL sung public-domain recordings of nursery
// rhymes when one is bundled (audio/nursery/*.ogg, listed with source +
// license in audio/nursery-manifest.json) instead of TTS reading lyrics.
// Matched on the literal topicPool item (sourcePoolItem), never on the
// LLM-reworded display topic - exact-text echo back from the model is
// fragile (see CLAUDE.md).
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { ffmpeg } from './ffmpeg.js';

const MANIFEST_PATH = path.resolve('audio/nursery-manifest.json');
const AUDIO_DIR = path.resolve('audio/nursery');

// Typical lengths popular kids channels publish; looping is the format.
export const NURSERY_TARGET_DURATION = { short: 50, long: 240 };

export async function resolveNurseryAudio(poolItem) {
  if (!poolItem || !existsSync(MANIFEST_PATH)) return null;
  const manifest = JSON.parse(await readFile(MANIFEST_PATH, 'utf8'));
  const entry = manifest.recordings.find((r) => r.topic === poolItem);
  if (!entry) return null;
  const filePath = path.join(AUDIO_DIR, entry.filename);
  return existsSync(filePath) ? { ...entry, path: filePath } : null;
}

export async function prepareNurseryAudio(nursery, outPath, seconds) {
  await ffmpeg(['-stream_loop', '-1', '-i', nursery.path, '-t', String(seconds),
    '-ar', '24000', '-ac', '1', '-c:a', 'libmp3lame', '-b:a', '128k', outPath]);
}

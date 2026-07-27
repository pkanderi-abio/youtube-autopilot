// Baby/toddler channels using babyLearning content mode should play
// REAL sung recordings of nursery rhymes when a matching public-domain
// audio file is bundled - not TTS reading the lyrics as spoken text
// (which doesn't work for the 1-4 year old audience).
//
// This module resolves a topic name to a bundled recording, and
// prepares it (loop + trim) to the video's target duration. If there's
// no matching recording, run-pipeline.js falls back to the normal Edge
// TTS narration path.
//
// Recordings live in backend/audio/nursery/*.ogg and are enumerated in
// backend/audio/nursery-manifest.json (sourceUrl + license per entry
// for auditability). All bundled files are public-domain sung
// recordings sourced from Wikimedia Commons.
import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { spawn } from 'child_process';
import path from 'path';
import ffmpegPath from 'ffmpeg-static';

const MANIFEST_PATH = path.resolve('audio/nursery-manifest.json');
const AUDIO_DIR = path.resolve('audio/nursery');

let cachedManifest = null;
async function loadManifest() {
  if (cachedManifest) return cachedManifest;
  const raw = await readFile(MANIFEST_PATH, 'utf8');
  cachedManifest = JSON.parse(raw);
  return cachedManifest;
}

// Looks up a topic in the manifest and returns { topic, filename, path,
// license, durationSeconds } if a matching bundled recording exists,
// otherwise null. Matches on exact topic string (topicPool entries and
// manifest topics are both curated so exact match is intentional).
export async function resolveNurseryAudio(topic) {
  if (!topic) return null;
  const manifest = await loadManifest();
  const entry = manifest.recordings.find((r) => r.topic === topic);
  if (!entry) return null;
  const filePath = path.join(AUDIO_DIR, entry.filename);
  if (!existsSync(filePath)) {
    console.warn(`[nursery] manifest lists ${entry.filename} for "${topic}" but file is missing at ${filePath}`);
    return null;
  }
  return { ...entry, path: filePath };
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn(ffmpegPath, args);
    let stderr = '';
    p.stderr.on('data', (d) => { stderr += d; });
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error('ffmpeg failed: ' + stderr)));
  });
}

// Loops the recording (via -stream_loop -1) and hard-trims to
// targetDurationSeconds, transcoding to MP3 so downstream steps see the
// same voice.mp3 shape they expect from the Edge TTS path. Looping is
// how popular baby channels stretch a 30s rhyme across a 4-minute
// video - repetition is the format, not a workaround.
export async function prepareNurseryAudio(nursery, outPath, targetDurationSeconds) {
  console.log(`[nursery] preparing "${nursery.topic}" (${nursery.durationSeconds}s source, looping to ${targetDurationSeconds}s target) -> ${outPath}`);
  await runFfmpeg([
    '-y',
    '-stream_loop', '-1',
    '-i', nursery.path,
    '-t', String(targetDurationSeconds),
    '-c:a', 'libmp3lame',
    '-b:a', '128k',
    outPath
  ]);
}

// Target durations when using pre-recorded audio. These are what
// popular kids channels actually publish - not the variable-length
// TTS output the pipeline currently defaults to. Short is Shorts-cap
// friendly; long is the typical 4-min compilation length.
export const NURSERY_TARGET_DURATION = {
  short: 50,
  long: 240
};

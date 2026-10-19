// Per-channel publish history (data/history-<channel>.json), committed back
// to the repo by CI via scripts/merge-and-push-history.js. Both formats of
// a channel share one file so topics never repeat across short and long.
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const DATA_DIR = path.resolve('data');
const KEEP = 200;

export async function loadHistory(channelId) {
  const file = path.join(DATA_DIR, `history-${channelId}.json`);
  if (!existsSync(file)) return { usedTopics: [], videos: [] };
  const parsed = JSON.parse(await readFile(file, 'utf8'));
  return { usedTopics: parsed.usedTopics || [], videos: parsed.videos || [] };
}

export async function saveHistory(channelId, history) {
  await mkdir(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, `history-${channelId}.json`);
  await writeFile(file, JSON.stringify({
    usedTopics: history.usedTopics.slice(-KEEP),
    videos: history.videos.slice(-KEEP)
  }, null, 2));
}

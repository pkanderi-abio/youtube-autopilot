// Tracks which topics/titles a channel has already used, so the trend
// step doesn't repeat itself. Persisted to data/history-<channel>.json
// and committed back to the repo by the GitHub Actions workflow.
import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

const DATA_DIR = path.resolve('data');

export async function loadHistory(channelId) {
  const file = path.join(DATA_DIR, `history-${channelId}.json`);
  if (!existsSync(file)) return { usedTopics: [], videos: [] };
  return JSON.parse(await readFile(file, 'utf8'));
}

export async function saveHistory(channelId, history) {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, `history-${channelId}.json`);
  // keep the file small - last 200 topics/videos is plenty of memory
  const trimmed = {
    usedTopics: history.usedTopics.slice(-200),
    videos: history.videos.slice(-200)
  };
  await writeFile(file, JSON.stringify(trimmed, null, 2));
}

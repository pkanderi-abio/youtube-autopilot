// Commits and pushes this job's updated data/history-<channelId>.json,
// re-deriving the merge from the latest remote state on every retry
// instead of git-rebasing a diff.
//
// Why: each channel can now run two format jobs (short/long) that both
// append to the SAME history file and can finish close together (see
// .github/workflows/pipeline.yml's matrix). A plain `git pull --rebase`
// retry loop works fine when two DIFFERENT files are touched (the old
// channel1-vs-channel2 case), but two commits that both append an entry
// near the end of the same JSON array can genuinely conflict at the
// text level - retrying the same rebase just hits the same conflict
// again, since nothing about the diff itself changes. Confirmed
// directly in production (run 29039387986): channel2's short-format job
// pushed its entry first, then the long-format job's rebase failed with
// "could not apply ... chore: update history for channel2 (long)" on
// all 5 retries, losing that video's history entry entirely.
//
// Fix: don't replay a diff. On every attempt, reset to the exact latest
// remote state, then re-merge THIS job's known-new entries (loaded once
// into memory before any git operations) into that fresh copy, keyed by
// video URL / topic string so re-merging is idempotent no matter how
// many times it's retried.
import { readFile, writeFile } from 'fs/promises';
import { execFileSync } from 'child_process';

const channelId = process.argv[2];
if (!channelId) {
  console.error('Usage: node scripts/merge-and-push-history.js <channelId>');
  process.exit(1);
}

const filePath = `data/history-${channelId}.json`;
const MAX_ATTEMPTS = 5;

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function mergeHistory(remote, ours) {
  const videos = [...remote.videos];
  const seenUrls = new Set(videos.map((v) => v.url));
  for (const v of ours.videos) {
    if (!seenUrls.has(v.url)) {
      videos.push(v);
      seenUrls.add(v.url);
    }
  }

  const usedTopics = [...remote.usedTopics];
  const seenTopics = new Set(usedTopics);
  for (const t of ours.usedTopics) {
    if (!seenTopics.has(t)) {
      usedTopics.push(t);
      seenTopics.add(t);
    }
  }

  return { usedTopics: usedTopics.slice(-200), videos: videos.slice(-200) };
}

async function run() {
  // Loaded once, before any git operations - this is the one source of
  // truth for "what did THIS job actually add," independent of however
  // many times the merge below gets retried against a moving remote.
  const ours = JSON.parse(await readFile(filePath, 'utf8'));

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    git(['fetch', 'origin', 'main']);
    git(['reset', '--hard', 'origin/main']);

    let remote = { usedTopics: [], videos: [] };
    try {
      remote = JSON.parse(await readFile(filePath, 'utf8'));
    } catch {
      // file doesn't exist on remote yet - first entry for this channel
    }

    const merged = mergeHistory(remote, ours);
    await writeFile(filePath, JSON.stringify(merged, null, 2));
    git(['add', filePath]);

    try {
      git(['commit', '-m', `chore: update history for ${channelId} [skip ci]`]);
    } catch {
      console.log('[merge-history] nothing new to commit - already up to date');
      return;
    }

    try {
      git(['push', 'origin', 'main']);
      console.log(`[merge-history] pushed on attempt ${attempt}`);
      return;
    } catch (err) {
      console.log(`[merge-history] push attempt ${attempt}/${MAX_ATTEMPTS} failed, retrying:`, err.message.split('\n')[0]);
    }
  }

  console.error('::error::could not push updated history after retries');
  process.exit(1);
}

run();

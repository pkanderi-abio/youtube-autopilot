#!/usr/bin/env node
// Reads the real backend state - channel config, publish history, and
// recent GitHub Actions runs (via `gh`, must be authenticated) - and
// writes data.json for index.html to fetch. Re-run this whenever you
// want the dashboard to reflect the latest state; there's no server,
// so "live" here means "as of the last time this ran."
import { readFile, writeFile } from 'fs/promises';
import { execSync } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(__dirname, '..', 'backend');
const CRON_EXPR = '0 14,2 * * *'; // keep in sync with .github/workflows/pipeline.yml

function ghJson(args) {
  return JSON.parse(execSync(`gh ${args}`, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 }));
}

function ghRaw(args) {
  try {
    return execSync(`gh ${args}`, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
  } catch {
    return '';
  }
}

async function loadChannels() {
  const raw = await readFile(path.join(BACKEND, 'config/channels.json'), 'utf8');
  return JSON.parse(raw).channels;
}

async function loadHistory(channelId) {
  try {
    const raw = await readFile(path.join(BACKEND, `data/history-${channelId}.json`), 'utf8');
    return JSON.parse(raw);
  } catch {
    return { usedTopics: [], videos: [] };
  }
}

function daysAgo(iso) {
  return (Date.now() - new Date(iso).getTime()) / 86400000;
}

// Parses a cron string like "0 14,2 * * *" (minute hour * * *, either
// field may be comma-separated) into the next few UTC run times.
function nextCronRuns(cronExpr, count = 4) {
  const [minutePart, hourPart] = cronExpr.trim().split(/\s+/);
  const minutes = minutePart.split(',').map(Number);
  const hours = hourPart.split(',').map(Number);
  const slots = [];
  for (const h of hours) for (const m of minutes) slots.push({ h, m });
  slots.sort((a, b) => a.h - b.h || a.m - b.m);

  const now = new Date();
  const results = [];
  for (let dayOffset = 0; dayOffset < 14 && results.length < count; dayOffset++) {
    for (const { h, m } of slots) {
      const candidate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + dayOffset, h, m, 0));
      if (candidate.getTime() > now.getTime()) results.push(candidate.toISOString());
    }
  }
  return results.slice(0, count);
}

function loadRecentRuns(limit) {
  try {
    return ghJson(
      `api repos/{owner}/{repo}/actions/workflows/pipeline.yml/runs --jq '.workflow_runs[:${limit}] | map({id, status, conclusion, created_at, html_url})'`
    );
  } catch (err) {
    console.warn('[build-data] could not fetch workflow runs:', err.message);
    return [];
  }
}

function loadJobsForRun(runId) {
  try {
    return ghJson(
      `api repos/{owner}/{repo}/actions/runs/${runId}/jobs --jq '.jobs | map({id, name, status, conclusion})'`
    );
  } catch {
    return [];
  }
}

const STAGE_NAMES = [
  'Discover topic', 'Generate script', 'Generate voiceover',
  'Generate background', 'Assemble video', 'Generate thumbnail', 'Upload YouTube'
];

// Parses real "[N/7] ..." progress markers out of a job's raw log into
// per-stage status - this is the actual last run's progression, not a
// simulation.
function parseStages(log) {
  const stages = STAGE_NAMES.map((name, i) => ({ step: i + 1, name, status: 'pending', detail: '' }));
  for (const line of log.split('\n')) {
    const stepMatch = line.match(/\[(\d)\/7]\s*(.+?)\.\.\.\s*$/);
    if (stepMatch) {
      const idx = Number(stepMatch[1]) - 1;
      if (idx > 0 && stages[idx - 1].status === 'running') stages[idx - 1].status = 'done';
      if (stages[idx]) stages[idx].status = 'running';
    }
    const arrowMatch = line.match(/->\s*(.+)$/);
    if (arrowMatch) {
      const runningIdx = stages.map(s => s.status).lastIndexOf('running');
      if (runningIdx >= 0) stages[runningIdx].detail = arrowMatch[1].trim().slice(0, 90);
    }
    if (/FAILED:/.test(line)) {
      const runningIdx = stages.map(s => s.status).lastIndexOf('running');
      if (runningIdx >= 0) {
        stages[runningIdx].status = 'failed';
        stages[runningIdx].detail = line.split('FAILED:')[1]?.trim().slice(0, 120) || 'failed';
      }
    }
    if (/published:/.test(line)) {
      stages[stages.length - 1].status = 'done';
    }
  }
  return stages;
}

function loadJobLog(jobId) {
  return ghRaw(`api repos/{owner}/{repo}/actions/jobs/${jobId}/logs`);
}

async function build() {
  const channels = await loadChannels();
  const recentRuns = loadRecentRuns(15);

  const channelData = [];
  for (const channel of channels) {
    const history = await loadHistory(channel.id);
    const videos = [...history.videos].sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));
    const videosLast7Days = videos.filter(v => daysAgo(v.publishedAt) <= 7).length;
    const videosLast30Days = videos.filter(v => daysAgo(v.publishedAt) <= 30).length;

    let stages = STAGE_NAMES.map((name, i) => ({ step: i + 1, name, status: 'pending', detail: '' }));
    let lastRunConclusion = null;
    let lastRunUrl = null;
    for (const run of recentRuns) {
      const job = loadJobsForRun(run.id).find(j => j.name.includes(`(${channel.id})`));
      if (job) {
        lastRunConclusion = job.conclusion || job.status;
        lastRunUrl = run.html_url;
        const log = loadJobLog(job.id);
        if (log) stages = parseStages(log);
        break;
      }
    }

    channelData.push({
      id: channel.id,
      name: channel.name,
      niche: channel.niche,
      format: channel.format,
      visualStyle: channel.visualStyle || 'gradient',
      madeForKids: Boolean(channel.madeForKids),
      totalVideos: videos.length,
      videosLast7Days,
      videosLast30Days,
      lastPublished: videos[0] || null,
      recentVideos: videos.slice(0, 6),
      lastRunConclusion,
      lastRunUrl,
      stages
    });
  }

  const data = {
    generatedAt: new Date().toISOString(),
    revenueNote: 'Revenue is not shown - this pipeline has no YouTube Analytics integration, so a dollar figure here would be fabricated.',
    channels: channelData,
    nextScheduledRuns: nextCronRuns(CRON_EXPR, 4),
    recentActivity: recentRuns.slice(0, 8).map(r => ({
      id: r.id,
      createdAt: r.created_at,
      status: r.status,
      conclusion: r.conclusion,
      url: r.html_url
    }))
  };

  await writeFile(path.join(__dirname, 'data.json'), JSON.stringify(data, null, 2));
  console.log(`Wrote frontend/data.json (${channelData.length} channels, ${data.recentActivity.length} recent runs)`);
}

build().catch((err) => {
  console.error('[build-data] failed:', err);
  process.exit(1);
});

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Two independent parts:

- **`backend/`** — the real automation pipeline. Runs 7 stages per publish:
  topic discovery → local Ollama script generation → free Edge TTS voice →
  background video (Pexels stock footage or animated gradient fallback) →
  ffmpeg assembly → thumbnail → YouTube upload. Deployed as scheduled
  GitHub Actions cron with **no human review checkpoint**. Two channels
  (`channel1` TeslaTravel, `channel2` Storytime Fables), each publishing
  both a `short` and a `long` format on its own cadence.
- **`frontend/`** — a static dashboard (`index.html` + `data.json`) that
  reflects real backend state. `data.json` is produced offline by
  `build-data.js`, which shells out to `gh api` for Actions run status
  and reads `../backend/config/channels.json` and `../backend/data/history-*.json`.
  No live polling — "live" means "as of the last time `build-data.js` ran."

The repo is **public** so GitHub Actions minutes are unlimited/free. Cron
cadence in `.github/workflows/pipeline.yml` is about content pacing (not
looking spammy on YouTube), not compute budget.

## Commands

### Backend (Node 20, ES modules)
```powershell
cd backend
npm install                          # ffmpeg-static postinstall pulls binary; retry on transient CDN failures
cp .env.example .env                 # fill in YT_CLIENT_ID/SECRET, YT_REFRESH_TOKEN_CHANNEL*, PEXELS_API_KEY
ollama pull llama3.2                 # required — pipeline aborts if Ollama unreachable

npm run run -- channel1              # runs channel's default format from channels.json
npm run run -- channel1 long         # override format (short | long)
npm run get-token                    # one-time OAuth flow, prints refresh token for one channel
```

No test suite, no linter — this is a pipeline project driven end-to-end by
`npm run run -- <channelId> [format]` (which just calls
`node src/run-pipeline.js`). To validate a change, run one channel locally
and inspect the produced video before pushing.

### Frontend (static)
```powershell
cd frontend
gh auth login                        # once, to authorize `gh api` calls
node build-data.js                   # regenerates data.json
python3 -m http.server 8099          # index.html must be served over http:// (fetch can't read file://)
```

### CI
`.github/workflows/pipeline.yml` — cron schedule (one entry per
channel+format pair) triggers a matrix `publish` job. Manual runs via
Actions tab support `channel` and `format` inputs to scope the fan-out.

## Architecture

### Pipeline flow

`src/run-pipeline.js` orchestrates stages 1–7 for one `(channel, format)` pair:

```
1-discover-topic   ── uses channel.topicPool if defined, else lib/trends.js daily trends
2-generate-script  ── short: 1 call; long: outline + N section calls, concatenated
3-generate-voice   ── Edge TTS → mp3
4-generate-background ── Pexels clips (one per script.scenes entry) OR animated gradient
5-assemble-video   ── ffmpeg mux background + voice; optional burned captions (currently off)
6-generate-thumbnail ── title text over channel brand gradient (node-canvas)
7-upload-youtube   ── googleapis videos.insert + thumbnails.set
```

After a successful upload, `run-pipeline.js` appends to
`data/history-<channelId>.json` (`usedTopics`, `videos`). In CI, that file
is committed and pushed by `scripts/merge-and-push-history.js`.

### Per-channel configuration

`backend/config/channels.json` is the single source of truth. Fields:
`id`, `name`, `niche`, `format` (default), `visualStyle` (`stockFootage` |
`gradient`), `madeForKids`, `brandColorA/B`, `refreshTokenEnv` (name of
env var holding that channel's refresh token), `categoryId`, `tags`.
Optional: `topicPool` (skip trends, draw from this list), `closingStyle`
(`"moral"` for story-lesson endings).

Both formats for a channel share the **same** `history-<channelId>.json`,
so topics never repeat across a channel's short and long videos.

### The small-local-model failure modes drove much of this code

- **`src/lib/llm.js`** is Ollama-only, no paid-API fallback, no template
  fallback. An earlier version fell back to a hardcoded template on
  Ollama failure and shipped visibly broken videos; now failure aborts
  the whole run. Requests use `format: 'json'` and are retried 3× with
  5s/10s backoff. `sanitizeJsonControlChars` fixes raw control chars
  llama3.2 sometimes emits inside JSON string values.
- **`src/steps/2-generate-script.js`** — llama3.2 unreliably hits large
  word-count targets in one shot. Short-form retries up to 3× and keeps
  the longest attempt; anything under `MIN_WORDS.short` (90) aborts.
  **Long-form is split into ~5 sections** (`generateScriptOutline` +
  N × `generateNarrationSection`, capped at `MAX_LONG_FORM_SECTIONS=8`)
  because a single 700–900-word ask reliably undershoots. Each section
  receives the previous section's tail for continuity. Aggregate must
  clear `MIN_WORDS.long` (550) or the run aborts. `fixAllCapsTitle`
  mechanically case-corrects clickbait-caps titles the prompt tells the
  model not to produce.
- **`src/steps/1-discover-topic.js`** — the prompt is heavily
  example-driven because the small model tends to lift a raw trending
  term (a sports score, an anchor's name) and produce content unrelated
  to the channel's niche. The returned `topic` field must already read
  as a niche-fit topic.

**General principle: fail loud, don't ship broken content.** Publishing
a mangled video is worse than skipping a run.

### Visuals

`src/steps/4-generate-background.js` produces a **sequence of short shots**
(not one continuous background), each with its own fast zoom/pan toward a
different focus point — a single slowly-creeping background over 45s+ read
as static (near-zero bitrate) in early testing. Each shot is either:
- one Pexels stock clip matching a `script.scenes[i]` search phrase
  (cover-cropped/looped/trimmed to shot duration), or
- an on-brand gradient variant (used as fallback if Pexels fails or if
  `channel.visualStyle === "gradient"`).

`src/lib/stockFootage.js` — picks the smallest Pexels file that still
meets target resolution (4K masters would waste bandwidth for 1080p output).

### YouTube upload nuances

`src/steps/7-upload-youtube.js`:
- `selfDeclaredMadeForKids` is set from `channel.madeForKids`. YouTube
  then disables comments, personalized ads, notifications, and
  end-screens/cards on that video — expected, not a bug.
- After `videos.insert` succeeds, the video is **already live**. A
  subsequent `thumbnails.set` failure is warn-and-continue (retried 3×
  first): losing the default thumbnail is strictly better than aborting
  after publish and losing the history entry entirely (real prior
  incident — orphaned upload with no tracking).
- `src/lib/youtube.js` builds the googleapis client from
  `YT_CLIENT_ID`/`YT_CLIENT_SECRET` + the per-channel refresh token
  named in `channel.refreshTokenEnv`.

### History file concurrency

`scripts/merge-and-push-history.js` runs in CI after each pipeline job.
Both format jobs (short + long) for the same channel can finish close
together and both append to the same `history-<channelId>.json`. A plain
`git pull --rebase` retry loop **cannot** resolve a text-level conflict
inside the same JSON array — retrying replays the same diff and hits the
same conflict every time (real prior incident lost a channel2 long-form
entry across 5 rebase attempts).

Fix: this script loads THIS job's entries once into memory, then on each
attempt does `git fetch && git reset --hard origin/main` and re-merges
its known-new entries into the fresh remote copy — keyed by video URL
and topic string, so re-merging is idempotent no matter how many times
push races against another job. Do not "fix" this back to `git pull --rebase`.

### Workflow scheduling

`.github/workflows/pipeline.yml` has **one cron entry per
(channel, format) pair** (currently 4 total). The `plan` job maps
`github.event.schedule` back to `[{channel, format}]`; the `publish` job
matrix-expands and runs one pipeline invocation per pair. When adding a
channel or format, add both the cron line AND its case in the schedule
lookup. `workflow_dispatch` inputs `channel` and `format` scope manual runs.

## Conventions

- **ES modules everywhere** (`"type": "module"` in `package.json`). Use
  `import`, not `require`.
- **All paths in backend are resolved relative to `backend/`** — the
  pipeline is designed to run from that CWD (`working-directory: backend`
  in CI). `config/channels.json` and `data/history-*.json` are read via
  `path.resolve('config/…')`, not relative to `__dirname`.
- **No test framework, no lint config, no build step.** Validation is
  running the pipeline end-to-end.
- **`.env` is local-only** (see `.env.example`). In CI, everything is a
  GitHub Actions repo secret. Never commit a real `.env`.
- **Failures should abort the run**, not fall back to templated content.
  See `src/lib/llm.js` header comment — this is a load-bearing decision,
  not laziness.
- **Ollama is required.** CI installs it as a systemd service and waits
  up to 60s for `:11434`. Locally, `ollama pull llama3.2` must have run.

# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Two independent parts:

- **`backend/`** — the real automation pipeline. Runs 8 stages per publish:
  topic discovery → local Ollama script generation → dedicated SEO/metadata
  pass → free Edge TTS voice → background video (Pexels stock footage or
  animated gradient fallback) → ffmpeg assembly → thumbnail (+ an A/B
  variant saved as a CI artifact) → YouTube upload. Deployed as scheduled
  GitHub Actions cron with **no human review checkpoint**. Two channels
  (`channel1` TeslaTravel, `channel2` Storytime Fables), each publishing
  both a `short` and a `long` format on its own cadence. A separate daily
  workflow (`analytics.yml`) pulls real view/like counts back into
  `data/analytics-<channelId>.json`, which both the dashboard and topic
  discovery read.
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
npm run fetch-analytics              # pulls real view/like/comment counts for all channels' published videos
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
`.github/workflows/analytics.yml` runs once daily (independent schedule)
to refresh real view/like/comment counts.

## Architecture

### Pipeline flow

`src/run-pipeline.js` orchestrates stages 1–8 for one `(channel, format)` pair:

```
1-discover-topic   ── uses channel.topicPool if defined (with cooldown-based
                       dedup, see below), else lib/trends.js daily trends
2-generate-script  ── narration + captionLines + scenes ONLY (no metadata);
                       short: 1 call; long: outline + N section calls, concatenated
3-optimize-seo     ── dedicated pass: title/description/tags/hashtags/commentCta,
                       grounded in the FINISHED narration, with a recent-title
                       similarity guard (see below)
4-generate-voice   ── Edge TTS → mp3
5-generate-background ── Pexels clips (one per script.scenes entry) OR animated gradient
6-assemble-video   ── ffmpeg mux background + voice; optional burned captions (currently off)
7-generate-thumbnail ── two compositions (node-canvas): one uploaded, one saved as
                       a CI artifact for manual comparison (no real A/B test exists
                       via the Data API)
8-upload-youtube   ── googleapis videos.insert + thumbnails.set
```

After a successful upload, `run-pipeline.js` appends to
`data/history-<channelId>.json` (`usedTopics`, `videos` — each video entry
also carries `sourcePoolItem` when the topic came from a `topicPool`). In
CI, that file is committed and pushed by `scripts/merge-and-push-history.js`.

### SEO stage and duplicate-title/topic guards

Splitting step 3 out of step 2 fixed a real production issue: title/
description used to be requested in the SAME call as the narration
(before the script existed), and near-duplicate topics slipped through
undetected because each was invented fresh each run — e.g. three separate
"Fiji's Best Hidden Beaches" videos on channel1 within a week, and five
differently-worded "Mary Had a Little Lamb" videos on channel2 within two
weeks (none matched `history.usedTopics` literally, so the old exact-
string filter never caught them). Two independent guards now exist:

- **`src/steps/1-discover-topic.js`** tracks which literal `topicPool`
  item a topic was drawn from as `sourcePoolItem` on the history video
  entry, and excludes any item used within the last `POOL_COOLDOWN_VIDEOS`
  (6) videos from the candidate pool — catching reuse regardless of how
  differently the LLM rewords the topic each time.
- **`src/steps/3-optimize-seo.js`** additionally checks the generated
  title against the channel's last 15 published titles for word-overlap
  similarity (`titleTooSimilar`) and requests a rewrite (up to 2 attempts)
  if it's too close to something recently published, on top of the
  existing vague/abstract-title check (`titleLooksVague`).

### Analytics feedback loop

`scripts/fetch-analytics.js` (run by `analytics.yml`, or manually via
`npm run fetch-analytics`) pulls real `viewCount`/`likeCount`/
`commentCount` per video via `videos.list(part=statistics)`, using the
SAME OAuth refresh tokens already used for uploads — `get-refresh-
token.js` requests the full `youtube` scope (not just `.upload`), which
already covers reading stats on the channel's own videos, so no new
consent/credential is needed. Output: `data/analytics-<channelId>.json`.

`src/lib/analytics.js`'s `poolPerformanceHint()` reads that file
(best-effort — absent entirely until the first `analytics.yml` run) and
folds a "best/worst performing recent topics" summary into step 1's
topic-selection prompt once there's enough data (≥6 distinct pool items
with stats). This is the piece that was previously completely missing —
frontend's dashboard used to state outright that view counts didn't
exist anywhere in the system.

### Per-channel configuration

`backend/config/channels.json` is the single source of truth. Fields:
`id`, `name`, `niche`, `format` (default), `visualStyle` (`stockFootage` |
`gradient` | `cartoonAnimation` — see Visuals below), `madeForKids`,
`brandColorA/B`, `refreshTokenEnv` (name of env var holding that
channel's refresh token), `categoryId`, `tags`. Optional: `topicPool`
(skip trends, draw from this list), `closingStyle` (`"moral"` for
story-lesson endings), `contentStyle` (`"babyLearning"` reshapes the
script prompt's hook/vocabulary/closing for toddlers — see
`hookAndStyleInstructions`/`closingLineHint` in `2-generate-script.js`).

Renaming a channel's `name` here only changes what's fed into script/SEO
generation — it does **not** rename the actual YouTube channel or
handle (set manually in YouTube Studio), so don't assume the `name` in
config matches the channel's public YouTube branding.

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
  clear `MIN_WORDS.long` (550) or the run aborts. This step only produces
  narration/captions/scenes now — title-quality guards (`fixAllCapsTitle`,
  `titleLooksVague`) live in step 3 (`optimize-seo.js`) alongside the rest
  of the metadata generation.
- **`src/steps/1-discover-topic.js`** — the prompt is heavily
  example-driven because the small model tends to lift a raw trending
  term (a sports score, an anchor's name) and produce content unrelated
  to the channel's niche. The returned `topic` field must already read
  as a niche-fit topic. Both channels now have a `topicPool` (channel1's
  is evergreen "Did You Know"-style facts, added specifically so it isn't
  fully dependent on the LLM correctly filtering trending celebrity/sports/
  politics content every single run — which is exactly what happened for
  roughly channel1's first three weeks and channel2's first three weeks
  of publishing, before their pools existed). The pool-cooldown dedup
  asks the model for a `sourceIndex` **number** into the numbered
  candidate list, not the candidate text itself — an earlier version
  asked it to echo the exact candidate string back, which silently
  broke the cooldown whenever the model paraphrased even slightly while
  writing `topic` (confirmed directly: the same pool item got reused 8
  hours and one video later because its first use didn't string-match
  and so never registered as "recently used"). A small integer is much
  harder for a small model to get wrong than reproducing text
  byte-for-byte — this same asymmetry is worth remembering anywhere else
  a prompt needs the model to reference one of several options back.
- **Prompt examples get reproduced, not generalized from.** The
  baby-content scene-phrase prompt in `2-generate-script.js` used to
  include `"baby playing with toys"` as one of several example search
  phrases; the model kept outputting that exact phrase (or a close
  paraphrase) across videos regardless of actual topic, because a
  single generic example reads as a safe default rather than one
  illustration among many. Confirmed directly: a "Little Bo Peep"
  video's thumbnail showed an unrelated toy truck. Fix was to vary the
  examples across unrelated topics/objects (nothing to anchor on) and
  explicitly require every output to be drawn from the specific topic
  at hand, with the bad phrase named as a negative example. Any prompt
  built for this model should assume a single concrete example can
  become the model's default output, not just an illustration.

**General principle: fail loud, don't ship broken content.** Publishing
a mangled video is worse than skipping a run.

### Visuals

`src/steps/5-generate-background.js` produces a **sequence of short shots**
(not one continuous background), each with its own fast zoom/pan toward a
different focus point — a single slowly-creeping background over 45s+ read
as static (near-zero bitrate) in early testing. Each shot is one of:
- **`stockFootage`** (both current channels): one Pexels stock clip
  matching a `script.scenes[i]` search phrase (cover-cropped/looped/
  trimmed to shot duration). `findStockFootageClip` picks randomly among
  the top `RESULT_POOL_SIZE` (15, out of `PAGE_SIZE`=20 fetched) results
  rather than always the top hit — a channel publishing 40+ videos off
  recurring generic scene phrases needs real headroom, or the same
  small pool just gets reused (pigeonhole principle). Same idea applies
  to *which* shot supplies the thumbnail/opening frame: `run()` in that
  file picks a random `heroShotIndex` each run rather than hardcoding
  shot 0, since shot 0's query is usually the generic "opening hook"
  and barely varies topic to topic.
- **`cartoonAnimation`**: procedurally animated shapes/numbers/letters
  drawn with node-canvas (`cartoonClip`/`renderCartoonFrameToCanvas`),
  classified per scene text (number/color/letter/default). Not
  currently used by either channel — it was tried for channel2, proved
  unreliable on the GitHub-hosted CI runner (a Cairo/canvas 2.11 bug
  silently produced broken frames; JPEG-not-PNG frame encoding and
  `validateCartoonBackground`'s post-encode pixel check were both added
  to try to harden it, and it still wasn't reliable enough), and was
  reverted to `stockFootage` — but the code is kept working and ready
  in case a future canvas upgrade or a fresh diagnostic pass makes it
  viable again. Don't re-enable it without re-verifying that reliability
  bar on the actual CI runner first.
- **`gradient`**: an on-brand two-color gradient with a zoom/pan. Used
  directly if configured, and as the automatic fallback whenever
  `stockFootage`/`cartoonAnimation` fails for a shot. A missing/invalid
  `PEXELS_API_KEY` on a `stockFootage` channel throws immediately at the
  start of `generateBackground` rather than silently degrading every
  shot of every video to this fallback forever — that silent-degrade
  behavior is exactly what a real incident looked like from the outside
  (weeks of same-2-brand-colors, barely-animated video with no hard
  failure anywhere to explain why).

`src/lib/stockFootage.js` — picks the smallest Pexels file that still
meets target resolution (4K masters would waste bandwidth for 1080p output).

`src/steps/7-generate-thumbnail.js` renders two compositions per video
(`renderVariant` with `flip: false`/`true` — swapped emphasis-word/rest-
text layout, opposite-corner badge, different accent color) and uploads
only the primary; both are attached to the CI run as a downloadable
artifact since the Data API can't run a real Studio A/B test. The
corner-badge accent is a **vector-drawn icon** (`drawIcon`: circle/star/
heart/flower/triangle via canvas paths), not an emoji character —
ubuntu-latest ships no emoji-capable font, and a fix attempt (adding
`fonts-noto-emoji` to the CI apt-get step) turned out to name a package
that doesn't exist, which broke `apt-get install` and silently failed
**every** scheduled run on both channels for 3 days before anyone
noticed. See "Editing `pipeline.yml` safely" below before touching that
install step again.

### YouTube upload nuances

`src/steps/8-upload-youtube.js`:
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

A third job, `notify-on-failure` (`needs: publish`, `if: always()`),
runs regardless of `publish`'s outcome and maintains a single
`pipeline-failure`-labeled GitHub issue via `actions/github-script` and
the built-in `GITHUB_TOKEN` (no extra secret): opens it on the first
failure, comments on subsequent failures instead of opening duplicates,
and auto-closes it with a resolution comment once a run succeeds again.
This exists because a real outage (below) ran for 3 days with the
pipeline "failing loudly" in the sense of exiting non-zero, but with
nothing surfacing that to anyone — check for an open issue with that
label before assuming a scheduled run actually happened recently.

### Editing `pipeline.yml` safely

There is no CI step that validates `pipeline.yml` itself before it
reaches `main` — the only thing that runs it is the schedule, against
whatever is on `main` at trigger time. A real incident: adding
`fonts-noto-emoji` to the "Install ffmpeg system libs" `apt-get install`
line (meant to fix an emoji-rendering issue) turned out to name a
package that doesn't exist on Ubuntu; `apt-get install` fails atomically
when any listed package is unresolvable, so that one bad name broke
**every** scheduled run on **both** channels for 3 days before anyone
noticed (no failure alerting existed yet either — see above). Before
adding any new `apt-get`/system package to that step, verify the exact
package name actually exists for the runner's Ubuntu release (e.g.
via packages.ubuntu.com) rather than trusting a remembered name —
there's no safety net between a bad line and a full publishing outage.

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
- **`canvas` needs a native build.** `npm install` compiles it against
  system libs (`libcairo2-dev`, `libpango1.0-dev`, etc. — see the CI
  install step) and a C/C++ toolchain (node-gyp). In an environment
  without one (e.g. no Visual Studio Build Tools on Windows), install
  still succeeds with `--ignore-scripts`, but anything importing
  `canvas` (steps 5 and 7) fails at runtime with `Cannot find module
  '../build/Release/canvas.node'` — that's an environment limitation,
  not a code bug; steps 1-4, 6, and 8 have no canvas dependency and can
  still be exercised in such an environment.

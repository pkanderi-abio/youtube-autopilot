# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Project overview

- **`backend/`** — scheduled pipeline that makes **fully AI-generated
  videos for free** and publishes them with **no human review**: topic →
  storyboard script → SEO → per-scene AI voice → per-scene AI images (+
  optional AI motion clips) → ffmpeg render → AI thumbnail → YouTube upload.
  Two channels (`channel1` TeslaTravel facts, `channel2` Storytime Fables
  toddler content), each publishing `short` and `long` on its own cron.
  `analytics.yml` pulls view counts daily into `data/analytics-<id>.json`,
  which topic selection reads.
- **`frontend/`** — static dashboard; `build-data.js` reads channels.json,
  history files and `gh api` run logs (parses the `[N/8] ...` / `-> ...` /
  `published:` log markers — keep their shape).

Repo is public so Actions minutes are free; cron cadence is about content
pacing, not compute.

## Commands (Node 20, ES modules, run from `backend/`)

```bash
npm install
npm run mock -- channel1 short            # offline: placeholder AI, no upload (best smoke test)
npm run dry-run -- channel1 long          # real AI, output in out/, no upload
npm run run -- channel2 short             # real AI + publish
node src/run-pipeline.js channel2 long --dry-run "--topic=Humpty Dumpty"
npm run get-token | npm run fetch-analytics
```

No test suite/linter. Validate a change with `npm run mock` for both
channels and both formats (4 runs) and look at frames from `out/`.

## Free providers (all external calls)

| | Primary | Fallback |
|---|---|---|
| LLM | Cloudflare Workers AI `llama-4-scout` | `llama-3.3-70b` |
| Images | Cloudflare `flux-1-schnell` | Pollinations FLUX |
| Motion clips (hook only) | Pollinations video (needs key) | still + camera move |
| Voice | Edge TTS (msedge-tts) | Cloudflare MeloTTS |

Cloudflare free tier = **10,000 neurons/day shared by every job**.
`lib/cloudflare.js` tallies an estimate per run (logged at the end) and
throws `QuotaExceededError` on the daily-allocation 429; images then switch
to Pollinations for the rest of the run. Don't raise scene counts or swap to
pricier models without redoing the budget in `backend/README.md`.

## Architecture

```
1-topic      topicPool (6-video cooldown via sourcePoolItem) + optional trends
2-script     { visualBible, scenes:[{narration, visual}] }  short: 1 call;
             long: outline + 6 section calls with previous tail
3-seo        title/description/tags/hashtags/thumbnailText/commentCta + guards
4-voice      TTS per scene + 0.3s pause → scene.duration is exact
5-visuals    image per scene (artStyle + visualBible in every prompt); clips
6-render     zoompan camera move per still (6 moves, rotating), hard cuts,
             optional ASS captions (libass in ffmpeg-static), mux audio
7-thumbnail  sharp + SVG text on AI hero image; A/B variants → CI artifact
8-upload     videos.insert (containsSyntheticMedia: true) + thumbnail/playlist/comment
```

History: `data/history-<id>.json` (`usedTopics`, `videos[{title,url,format,
publishedAt,sourcePoolItem?}]`), shared by both formats of a channel.

## Lessons that shaped the code — don't regress these

- **Fail loud, never ship broken content.** No templated fallback script;
  no silent placeholder visuals (a missing Pexels key once produced weeks of
  2-colour gradient videos). Every provider chain ends in a thrown error.
  `images.js` also rejects near-uniform (blank / safety-filtered) frames.
- **Ask models for indices, not echoed text.** Topic selection returns
  `sourceIndex`; echoing the candidate string broke the cooldown whenever
  the model paraphrased.
- **Pool candidates get no "invent something else" escape hatch** — the
  model used to freelance unrelated topics.
- **A single prompt example becomes the default output** (the "baby playing
  with toys" thumbnail on a Little Bo Peep video). Vary or omit examples.
- **Long-form is written in sections**; one big ask undershoots. Word floors:
  short 90, long 650; looped/repeated narration is retried, then aborts.
- **Near-duplicate titles** are caught by word-overlap against the last 15
  titles (`titleTooSimilar`) plus `titleLooksVague`; up to 2 rewrites.
- **Nursery audio matches `sourcePoolItem`**, never the reworded topic.
- **After `videos.insert` the video is live** — everything after it is
  warn-and-continue so history is never lost.
- **History merge** (`scripts/merge-and-push-history.js`) resets to remote
  and re-merges idempotently. Do not "fix" it back to `git pull --rebase`.
- **Static visuals read as frozen video** — every shot moves.
- **No apt-get in CI.** sharp and ffmpeg-static ship prebuilt binaries; text
  uses DejaVu Sans (preinstalled). A non-existent apt package
  (`fonts-noto-emoji`) once broke every run for 3 days. No emoji in rendered
  text. If you must add a system package, verify the exact name for the
  runner's Ubuntu release first.
- **Failures surface as a `pipeline-failure` issue** (auto-closed on the next
  success) — check it before assuming scheduled runs are healthy.

## Workflow scheduling

`.github/workflows/pipeline.yml`: one cron line per (channel, format) and a
matching case in the `plan` job; `workflow_dispatch` takes `channel` /
`format`. Model overrides via repo **variables** `CF_TEXT_MODEL`,
`CF_IMAGE_MODEL`, `POLLINATIONS_VIDEO_MODEL`.

## Conventions

- ES modules; paths resolved relative to `backend/` (`path.resolve('config/...')`).
- `.env` is local only; CI uses repo secrets `CF_ACCOUNT_ID`, `CF_API_TOKEN`,
  `POLLINATIONS_API_KEY` (optional), `YT_CLIENT_ID`, `YT_CLIENT_SECRET`,
  `YT_REFRESH_TOKEN_CHANNEL1/2`.
- Every LLM call passes a `mock` so `MOCK_AI=1` keeps the whole pipeline
  runnable offline — add one to any new call.
- `channels.json` `name` doesn't rename the real YouTube channel.

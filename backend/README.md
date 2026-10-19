# YouTube Autopilot — backend

A zero-cost pipeline that produces **fully AI-generated videos** — script,
voice, visuals, thumbnail, metadata — and publishes them to YouTube on a
GitHub Actions schedule.

```
1 topic      curated topicPool (+ optional Google Trends) → LLM picks + sharpens
2 script     LLM writes a STORYBOARD: [{ narration, visual prompt }] per scene
3 seo        title / description / tags / hashtags / thumbnail text / first comment
4 voice      AI voice per scene (Edge neural TTS → Cloudflare MeloTTS backup)
5 visuals    AI image per scene (Cloudflare FLUX → Pollinations backup)
             + optional AI motion clip for the hook scene(s)
6 render     ffmpeg: camera-move animation per still, clips, captions, audio
7 thumbnail  AI hero image + bold text (sharp), A/B variants kept as CI artifact
8 upload     YouTube Data API, AI-content disclosure flag set, playlist, first comment
```

Because voice is synthesized **per scene**, each image is on screen exactly
while its own words are spoken — no alignment heuristics.

## What's free, and the limits

| Piece | Provider | Free allowance |
|---|---|---|
| Script + SEO LLM | Cloudflare Workers AI (`llama-4-scout` → `llama-3.3-70b`) | 10,000 neurons/day shared |
| Scene images | Cloudflare `flux-1-schnell` (~58 neurons/image) | ≈ shared budget |
| Image fallback | Pollinations.ai FLUX | free tier, needs `POLLINATIONS_API_KEY` |
| AI motion clips | LTX-Video on a free Kaggle GPU (2× T4) | ~30 GPU-hours/week per Kaggle account |
| Motion clips (paid alt.) | Pollinations.ai video | ~0.4 pollen per clip, needs a balance |
| Voice | Microsoft Edge neural TTS (keyless) | unlimited, unofficial |
| Voice backup | Cloudflare MeloTTS (~20 neurons/min) | shared budget |
| Render | ffmpeg on GitHub Actions | free on a public repo |

**Daily budget.** A short (~9 scenes) costs ≈ 750 neurons, a ~7-minute long
video (~36 scenes + thumbnail) ≈ 3,000. The current schedule's busiest day
(3 shorts + 2 longs) is ≈ 8,300 — inside the 10,000/day free allocation, but
without much slack: switching `CF_TEXT_MODEL` to Llama 3.3 70B (better prose,
~3× the text cost) or images to FLUX-2 Klein pushes it over, and the
overflow then lands on Pollinations.
If Cloudflare reports the daily allowance is used up, images switch to
Pollinations for the rest of that run automatically. Each run logs its
estimated spend on the last line.

**Real AI motion.** Every scene image is animated into a ~4-second clip by
LTX-Video (open source, Apache-2.0) running on Kaggle's free GPUs: the run
uploads the images to a private Kaggle dataset, runs `kaggle/ltx_clips.py`
as a GPU job, and downloads the clips (slowed up to 1.6× to fill each
scene). This adds roughly 15–25 minutes to a Short and 30–60 to a long
video, and uses about 2.5 of Kaggle's ~30 weekly GPU hours on the busiest
day of the schedule. If Kaggle is busy, out of quota or fails, those scenes
fall back to the AI still + camera move, so publishing never stops.
`aiClips.maxClips` caps how many scenes get motion (default 10 short / 16
long); `LTX_STEPS` (default 30) trades quality for speed.

## Before you turn on zero-review autonomy

- YouTube's monetization policy targets **mass-produced, repetitive or
  "inauthentic" content**. Keep topics varied, check output for the first
  1–2 weeks, and keep volume modest. Every upload sets
  `containsSyntheticMedia: true` (YouTube's required AI disclosure).
- Spot-check facts — the script is told not to invent statistics, but LLMs
  still make mistakes.
- **Kids content** (`madeForKids: true`): YouTube disables comments,
  personalized ads, notifications and end screens on those videos — expected.
  It's also the most heavily moderated category; review it more, not less.

## One-time setup

### 1. Cloudflare Workers AI (free)
1. Create a free account at dash.cloudflare.com (no card needed).
2. Copy your **Account ID** (right sidebar of the dashboard).
3. My Profile → API Tokens → Create Token → template **"Workers AI"**
   (Workers AI Read + Edit). Copy the token.
4. Add repo secrets `CF_ACCOUNT_ID` and `CF_API_TOKEN`.

### 2. Pollinations (optional, recommended)
Sign up at enter.pollinations.ai and create a **secret (`sk_`) key** →
repo secret `POLLINATIONS_API_KEY`. Enables the image fallback with higher
limits and the AI motion clips. Without it, clips are skipped and there is no
image fallback (keyless Pollinations requests are now rejected).

### 3. Kaggle (free GPU for AI motion clips — optional, recommended)
1. Sign up at kaggle.com and **verify your phone number** (Settings → Phone
   verification). Kaggle only allows GPU + internet for verified accounts.
2. Settings → API → **Generate New Token** and copy it.
3. Add repo secrets `KAGGLE_USERNAME` (your Kaggle username) and
   `KAGGLE_API_TOKEN` (the token).

The first run creates a private dataset `ytap-<channel>-<format>-scenes` and
a private notebook `ytap-<channel>-<format>-ltx` in your Kaggle account;
later runs reuse them. Watch a run live under kaggle.com → Code → Your Work.

### 4. Google Cloud + YouTube API (per channel)
1. Google Cloud project → enable **YouTube Data API v3**.
2. OAuth client, type **Desktop app**; note Client ID/Secret.
3. `cp .env.example .env`, fill `YT_CLIENT_ID` / `YT_CLIENT_SECRET`.
4. `npm install && npm run get-token`, sign in with channel 1's account →
   repo secret `YT_REFRESH_TOKEN_CHANNEL1`. Repeat for channel 2.
5. Add `YT_CLIENT_ID` / `YT_CLIENT_SECRET` as repo secrets.

Default quota (10,000 units/day) covers ~5 uploads/day (an upload ≈ 1,600
units plus thumbnail/comment/playlist calls).

### 5. Configure channels — `config/channels.json`

| Field | Meaning |
|---|---|
| `id`, `name`, `niche` | identity + what the LLM writes about (`name` doesn't rename the real channel) |
| `format` | default `short` (vertical, ≤ 3 min) or `long` (16:9, ~7 min) |
| `artStyle` | appended to every image prompt — the channel's visual identity |
| `captions` | burn word-chunk captions into the video |
| `aiClips` | `{ "enabled": true, "provider": "auto", "scenes": "all", "maxClips": 10 }` — real AI motion: `provider` `kaggle` / `pollinations` / `auto`; `scenes` `"all"` or a list of indexes |
| `formats` | per-format overrides, e.g. `{ "long": { "captions": false } }` |
| `voice`, `voiceRate` | Edge TTS voice name and rate (e.g. `"-5%"`) |
| `imageModel` | override `CF_IMAGE_MODEL` for this channel (e.g. `@cf/black-forest-labs/flux-2-klein-4b` for native 9:16, ~2× the neurons) |
| `madeForKids`, `contentStyle: "babyLearning"` | toddler content rules + kids flag |
| `closingStyle: "moral"` | story-lesson endings |
| `topicPool`, `useLiveTrends` | curated topics (6-video cooldown) and/or daily trends |
| `brandColorA/B` | thumbnail accent colours |
| `refreshTokenEnv`, `categoryId`, `tags`, `playlistId` | YouTube upload settings |

Toddler channels play a **real sung public-domain recording** when the
topic matches one in `audio/nursery-manifest.json`, with AI illustrations
following the rhyme instead of narration.

### 6. Deploy
Push to GitHub (public repo = free Actions minutes). Scheduling lives in
`.github/workflows/pipeline.yml` — one cron line per (channel, format) plus
its case in the `plan` job. Run manually from the Actions tab with optional
`channel` / `format` inputs. A failing run opens a `pipeline-failure` issue
that closes itself after the next success.

## Running locally

```bash
cd backend
npm install
npm run mock -- channel1 short                 # fully offline: placeholder AI, no upload
npm run dry-run -- channel1 short              # real AI, writes out/channel1/*.mp4, no upload
npm run dry-run -- channel2 long "--topic=Baa Baa Black Sheep"
npm run run -- channel1 long                   # real AI + publish
```

`KEEP_WORKDIR=1` keeps the temp folder with every scene image/voice clip.
`AI_CLIPS=0` disables motion clips for a run.

## Files

```
src/run-pipeline.js      orchestrator (8 stages, log markers parsed by the dashboard)
src/steps/1-topic.js     topic selection + pool cooldown
src/steps/2-script.js    storyboard script (short: 1 call, long: outline + sections)
src/steps/3-seo.js       metadata + vague/duplicate title guards
src/steps/4-voice.js     per-scene TTS, exact scene durations
src/steps/5-visuals.js   AI images (+ AI clips)
src/steps/6-render.js    ffmpeg camera moves, captions, mux
src/steps/7-thumbnail.js sharp/SVG thumbnail, A/B variants
src/steps/8-upload.js    YouTube upload + growth actions
src/lib/cloudflare.js    Workers AI client (chat, FLUX, MeloTTS, neuron tally)
src/lib/llm.js           JSON completion, repair, model fallback, mock mode
src/lib/images.js        image provider chain + blank-frame check
src/lib/kaggleClips.js   real AI motion clips on a free Kaggle GPU
kaggle/ltx_clips.py      the LTX-Video image-to-video script that runs on Kaggle
src/lib/aiClips.js       optional paid Pollinations clips
src/lib/tts.js           Edge TTS → MeloTTS
scripts/                 OAuth token helper, analytics pull, history merge/push
```

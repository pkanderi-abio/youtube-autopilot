# YouTube Autopilot — backend

A fully autonomous pipeline that, on a schedule, picks a trending topic,
writes a script, generates a voiceover, assembles a video, generates a
thumbnail, and publishes it straight to YouTube — for 2 channels, with
no human review step, running on free GitHub Actions cron.

## What this actually is (read this first)

This is real, runnable code, not a mockup, and it's built entirely on
free/open-source tools — no paid API keys anywhere in the content
pipeline:

- **Script**: written by a local **Ollama** server (`llama3.2` by
  default) - no API key, no per-request cost. Quality is noticeably
  below a frontier hosted model (shorter/less precise instruction
  following) and generation is much slower (CPU inference), but it's
  genuinely free and self-hosted.
- **Voice**: Microsoft Edge's free TTS engine (no API key, no per-word cost).
- **Visuals**: per-channel `visualStyle` in `config/channels.json`:
  - `"gradient"` (e.g. Wanderlust Clips): a procedurally generated,
    slowly-animated two-color gradient — **not** stock footage or
    AI-generated video clips. $0 cost, effectively instant.
  - `"illustrated"` (e.g. Rainbow Little Learners): the script step
    breaks the video into scenes, and each scene gets a real
    AI-generated illustration from a **self-hosted stable-diffusion.cpp**
    (SD1.5, CPU-only) with a Ken Burns zoom, concatenated together. $0
    API cost, but **real compute cost**: on a GPU-less GitHub Actions
    runner, generating 8-14 full-quality images takes roughly **1-4+
    hours per video** - measured directly, not estimated. This is why
    this channel runs weekly, not daily (see the workflow schedule
    below). A failed scene image falls back to the gradient rather than
    failing the run.
- **Thumbnail**: title text over the channel's brand gradient, or (for
  illustrated channels) over the first generated scene image — clean and
  legible, not CTR-optimized by a model.

This produces the kind of "faceless" narrated Shorts you've likely seen
on YouTube — it will NOT produce cinematic AI footage, and the script/
image quality trade-off for being fully open-source/self-hosted is real,
not marketing.

## Before you turn on zero-review autonomy

YouTube's monetization policies require content to be original/
transformative, not just reused or repetitive filler — channels seen as
mass-producing near-identical, low-effort content risk **demonetization
or suspension**, which directly undermines the income goal here. Since
this pipeline has no human checkpoint:

- Start with a lower volume and watch the first 1-2 weeks of output
  closely before scaling up.
- Periodically skim published videos/scripts for quality and factual
  accuracy — the script step is instructed not to fabricate stats, but
  LLMs (especially a small self-hosted one) can still get things wrong,
  and more often than a larger hosted model would.
- Keep an eye on YouTube Studio for any policy strikes.
- **Kids content (`madeForKids: true` channels, e.g. Rainbow Little
  Learners)**: this sets `selfDeclaredMadeForKids: true` on upload, which
  YouTube enforces by disabling comments, personalized ads, notifications,
  and end screens/cards on those videos — expected, not a bug. Kids
  content is also one of YouTube's most heavily moderated categories;
  give this channel's early output extra scrutiny, not less.

## One-time setup

### 1. Ollama (script/topic generation)
Install Ollama locally (`brew install ollama` or see ollama.com) and
run `ollama pull llama3.2`. No API key, no repo secret needed - CI
installs and pulls the model itself (see the workflow file). If Ollama
is unreachable for any reason, the pipeline falls back to a basic
template generator rather than failing the run - real output quality
requires Ollama actually running.

### 2. stable-diffusion.cpp (only for channels with `"visualStyle": "illustrated"`)
For local testing: build or download `sd-cli` from
[leejet/stable-diffusion.cpp](https://github.com/leejet/stable-diffusion.cpp)
and download a GGUF model (this project uses
`gpustack/stable-diffusion-v1-5-GGUF`, the `Q8_0` quantization). Point
`SD_CPP_BIN` / `SD_CPP_MODEL` at them (see `.env.example`). CI downloads
and caches both automatically - no local setup needed just to deploy.

**Note on SD2.x/Turbo models**: this project deliberately uses SD1.5, not
a "Turbo" variant. An SD2.1-based turbo GGUF model was tested first and
produced blank/white output - SD2.x support in stable-diffusion.cpp is
known to be unreliable. SD1.5 is the best-supported architecture in this
tool and was verified end-to-end (real, correct images) before shipping.

### 3. Google Cloud + YouTube API access (per channel)
1. Create a Google Cloud project → enable **YouTube Data API v3**.
2. Create OAuth 2.0 credentials → Application type **Desktop app**.
   Note the Client ID/Secret.
3. Copy `.env.example` to `.env` and fill in `YT_CLIENT_ID` / `YT_CLIENT_SECRET`.
4. Run `npm install && npm run get-token`, sign in with the **first**
   channel's Google account when the browser opens, and copy the
   printed refresh token into a repo secret `YT_REFRESH_TOKEN_CHANNEL1`.
5. Repeat step 4 signing in with the **second** channel's account →
   `YT_REFRESH_TOKEN_CHANNEL2`.
6. Add `YT_CLIENT_ID` / `YT_CLIENT_SECRET` as repo secrets too.

Default API quota (10,000 units/day) covers this volume easily — an
upload costs 1,600 units, so roughly 6 uploads/day/project before
you'd need to request a quota increase.

### 4. Configure your channels
Edit `config/channels.json` — names, niche, format (`short` or `long`),
`visualStyle` (`gradient` or `illustrated`), `madeForKids`, brand colors,
YouTube category ID. Renaming a channel here only changes what's fed into
script generation — it does **not** rename the actual YouTube channel or
handle, which you set manually in YouTube Studio.

### 5. Deploying
Push the **contents** of this `backend/` folder as the root of a new
GitHub repo (so `package.json` and `.github/` sit at the repo root).
Add the YouTube secrets above under Settings → Secrets and variables →
Actions (no LLM/image API keys needed at all). The workflow
(`.github/workflows/pipeline.yml`) runs automatically on its cron
schedule, or trigger it manually from the Actions tab.

## Running locally (for testing)
```
npm install
cp .env.example .env   # fill in YouTube values; Ollama/SD settings are optional locally
ollama pull llama3.2
npm run run -- channel1
```

## Cost estimate
- Ollama, Edge TTS, ffmpeg, node-canvas, stable-diffusion.cpp: all free,
  self-hosted, $0 in API costs, period.
- YouTube Data API: free within default quota.
- **GitHub Actions compute minutes** are the one real resource here, and
  it's not negligible: this private repo gets 2,000 free minutes/month.
  Channel1 (gradient, twice daily) uses roughly 10-15 min/day. Channel2
  (illustrated, self-hosted SD) runs only **once a week** specifically
  because a single run can take **1-4+ hours** of that budget - check
  your Actions usage under Settings → Billing after your first couple of
  channel2 runs and adjust the cron schedule in
  `.github/workflows/pipeline.yml` if it's eating too much of the
  monthly allowance.

## Extending later
- `src/steps/4-generate-background.js` → swap in real stock footage or
  an AI video API (paid, but real motion instead of stills).
- `src/lib/llm.js` → swap in a bigger local model (edit `OLLAMA_MODEL`)
  or a hosted API if you decide the quality trade-off isn't worth it.
- `src/steps/6-generate-thumbnail.js` → add real CTR-prediction logic,
  or generate multiple variants and use YouTube's Test & Compare.
- Add an approval-gate mode (hold uploads as `privacyStatus: 'private'`
  and flip to public after a manual check) if you want a human back in
  the loop later — one-line change in `src/steps/7-upload-youtube.js`.
- Feed `youtube.reports` (YouTube Analytics API) data back into step 1
  so topic selection learns from what actually performed well.

## Files
- `src/steps/1-discover-topic.js` … `7-upload-youtube.js` — the pipeline stages
- `src/run-pipeline.js` — orchestrator, run once per channel
- `src/lib/` — LLM (Ollama), image generation (stable-diffusion.cpp),
  YouTube auth, trends, and history-state helpers
- `scripts/get-refresh-token.js` — one-time OAuth helper
- `config/channels.json` — per-channel config
- `data/history-<channel>.json` — auto-generated memory of used topics/videos
- `.github/workflows/pipeline.yml` — cron schedule + Ollama/stable-diffusion.cpp setup

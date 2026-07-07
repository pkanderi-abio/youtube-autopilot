# YouTube Autopilot — backend

A fully autonomous pipeline that, on a schedule, picks a trending topic,
writes a script, generates a voiceover, assembles a video, generates a
thumbnail, and publishes it straight to YouTube — for 2 channels, with
no human review step, running on free GitHub Actions cron.

## What this actually is (read this first)

This is real, runnable code, not a mockup. But be clear-eyed about what
"AI video generation" means here on a minimal budget:

- **Script**: written by Claude (Anthropic API) — cheap, good quality.
- **Voice**: Microsoft Edge's free TTS engine (no API key, no per-word cost).
- **Visuals**: per-channel `visualStyle` in `config/channels.json`:
  - `"gradient"` (e.g. Wanderlust Clips): a procedurally generated,
    slowly-animated two-color gradient — **not** stock footage or
    AI-generated video clips. $0 cost.
  - `"illustrated"` (e.g. Rainbow Little Learners): the script step
    breaks the video into scenes, and each scene gets an AI-generated
    still illustration (OpenAI images API, low-cost/low-quality tier)
    with a slow Ken Burns zoom, concatenated together. Real per-video
    cost here — see OpenAI's current image pricing. A failed scene
    image falls back to the gradient rather than failing the run.
  Swapping in real b-roll (Pexels API) or an AI video-clip API
  (Runway/Pika/Kling) is a further drop-in replacement for
  `src/steps/4-generate-background.js` once you want to spend more.
- **Thumbnail**: title text over the channel's brand gradient, or (for
  illustrated channels) over the first generated scene image — clean and
  legible, not CTR-optimized by a model.

This produces the kind of "faceless" narrated Shorts you've likely seen
on YouTube — it will NOT produce cinematic AI footage.

## Before you turn on zero-review autonomy

YouTube's monetization policies require content to be original/
transformative, not just reused or repetitive filler — channels seen as
mass-producing near-identical, low-effort content risk **demonetization
or suspension**, which directly undermines the income goal here. Since
this pipeline has no human checkpoint:

- Start with a lower volume (this default: 2 videos/day/channel) and
  watch the first 1-2 weeks of output closely before scaling up.
- Periodically skim published videos/scripts for quality and factual
  accuracy — the script step is instructed not to fabricate stats, but
  LLMs can still get things wrong.
- Keep an eye on YouTube Studio for any policy strikes.
- **Kids content (`madeForKids: true` channels, e.g. Rainbow Little
  Learners)**: this sets `selfDeclaredMadeForKids: true` on upload, which
  YouTube enforces by disabling comments, personalized ads, notifications,
  and end screens/cards on those videos — expected, not a bug. Kids
  content is also one of YouTube's most heavily moderated categories;
  give this channel's early output extra scrutiny, not less.

## One-time setup

### 1. Anthropic API key
Create a key at console.anthropic.com → add it as a repo secret
`ANTHROPIC_API_KEY`. Claude Haiku costs fractions of a cent per script.

### 1b. OpenAI API key (only if any channel uses `"visualStyle": "illustrated"`)
Create a key at platform.openai.com → add it as a repo secret
`OPENAI_API_KEY`. Used to generate per-scene illustration images for
those channels — check OpenAI's current image pricing before scaling up
volume, since this is the one real per-video cost in this pipeline.

### 2. Google Cloud + YouTube API access (per channel)
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

### 3. Configure your channels
Edit `config/channels.json` — names, niche, format (`short` or `long`),
`visualStyle` (`gradient` or `illustrated`), `madeForKids`, brand colors,
YouTube category ID. Renaming a channel here only changes what's fed into
script generation — it does **not** rename the actual YouTube channel or
handle, which you set manually in YouTube Studio.

### 4. Deploying
Push the **contents** of this `backend/` folder as the root of a new
GitHub repo (so `package.json` and `.github/` sit at the repo root).
Add the secrets above under Settings → Secrets and variables → Actions.
The workflow (`.github/workflows/pipeline.yml`) runs automatically on
its cron schedule, or trigger it manually from the Actions tab.

## Running locally (for testing)
```
npm install
cp .env.example .env   # fill in real values
npm run run -- channel1
```

## Cost estimate (minimal-budget setup)
- Claude Haiku: ~$0.01–0.02/video
- Edge TTS, ffmpeg, node-canvas: free
- GitHub Actions: free on public repos; ~2,000 free minutes/month on
  private repos (this uses roughly 10-15 min/day total)
- YouTube Data API: free within default quota
- OpenAI images (only `"visualStyle": "illustrated"` channels): 8-14
  images/video at the low-quality tier — check OpenAI's current pricing
  and multiply by your daily volume before scaling up; this is the one
  line item here that isn't ~$0.

Gradient-only channels: expect well under $5/month in API costs.

## Extending later
- `src/steps/4-generate-background.js` → swap in real stock footage or
  an AI video API.
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
- `src/lib/` — Anthropic, OpenAI images, YouTube auth, trends, and history-state helpers
- `scripts/get-refresh-token.js` — one-time OAuth helper
- `config/channels.json` — per-channel config
- `data/history-<channel>.json` — auto-generated memory of used topics/videos
- `.github/workflows/pipeline.yml` — the cron schedule

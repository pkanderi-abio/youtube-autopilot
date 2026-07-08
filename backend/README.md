# YouTube Autopilot — backend

A fully autonomous pipeline that, on a schedule, picks a trending topic,
writes a script, generates a voiceover, assembles a video, generates a
thumbnail, and publishes it straight to YouTube — for 2 channels, with
no human review step, running on free GitHub Actions cron.

## What this actually is (read this first)

This is real, runnable code, not a mockup, and it's built entirely on
free/open-source tools and free-tier APIs — no paid API keys anywhere
in the content pipeline:

- **Script**: written by a local **Ollama** server (`llama3.2` by
  default) - no API key, no per-request cost. Quality is noticeably
  below a frontier hosted model (shorter/less precise instruction
  following) and generation is much slower (CPU inference), but it's
  genuinely free and self-hosted. Long-form scripts are generated
  section-by-section (an outline call, then one call per narrative
  beat) rather than in one shot - a small local model reliably
  undershoots a single big word-count target, but hits a small
  per-section target consistently.
- **Voice**: Microsoft Edge's free TTS engine (no API key, no per-word cost).
- **Visuals**: per-channel `visualStyle` in `config/channels.json`:
  - `"stockFootage"` (both current channels): the script step also
    produces a `scenes` array of short search phrases, and each shot
    downloads a real matching clip from **Pexels'** free stock-video API
    (registered key, no paid tier), cover-cropped/looped/trimmed to the
    shot's duration. A failed search/download for a given shot falls
    back to the gradient rather than failing the run.
  - `"gradient"`: a procedurally generated, slowly-animated two-color
    gradient — not stock footage or AI-generated video. $0 cost,
    effectively instant. This is also the fallback used whenever stock
    footage fails for a shot.
- **Thumbnail**: title text over the channel's brand gradient — clean
  and legible, not CTR-optimized by a model.

This produces the kind of "faceless" narrated Shorts/long-form videos
you've likely seen on YouTube using real b-roll footage — it will NOT
produce cinematic bespoke AI video generation, and the script quality
trade-off for self-hosting the LLM is real, not marketing.

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
fails (unreachable, or the model server crashes) the pipeline aborts
that run rather than publishing broken/templated content - real output
requires Ollama actually working.

### 2. Pexels API key (stock footage)
Get a free key at [pexels.com/api](https://www.pexels.com/api/) (instant,
no approval wait) and add it as a repo secret named `PEXELS_API_KEY`
(and optionally in your local `.env` for testing). No paid tier. If this
key is missing or a search comes up empty, that shot falls back to the
gradient rather than failing the run.

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
`visualStyle` (`gradient` or `stockFootage`), `madeForKids`, brand colors,
YouTube category ID. Renaming a channel here only changes what's fed into
script generation — it does **not** rename the actual YouTube channel or
handle, which you set manually in YouTube Studio.

### 5. Deploying
Push this repo to GitHub (`package.json` and `.github/` at the repo
root). Add the YouTube + Pexels secrets above under Settings → Secrets
and variables → Actions. The workflow
(`.github/workflows/pipeline.yml`) runs automatically on its cron
schedule, or trigger it manually from the Actions tab.

## Running locally (for testing)
```
npm install
cp .env.example .env   # fill in YouTube + Pexels values; Ollama settings are optional locally
ollama pull llama3.2
npm run run -- channel1
```

## Cost estimate
- Ollama, Edge TTS, ffmpeg, node-canvas: all free, self-hosted, $0 in
  API costs, period. Pexels' video search API is free within its
  registered-key tier.
- YouTube Data API: free within default quota.
- **GitHub Actions compute minutes** are the one real resource here:
  this private repo gets 2,000 free minutes/month. Both channels are
  now a single job each (topic → script → voice → stock-footage
  download → assemble → upload) - channel2's weekly cadence predates
  the switch to stock footage (it used to be throttled by slow
  self-hosted Stable Diffusion generation) and could likely be
  increased now; check Actions usage under Settings → Billing before
  bumping the cron schedule in `.github/workflows/pipeline.yml`.

## Extending later
- `src/lib/stockFootage.js` → swap in a paid AI video-generation API
  (real bespoke motion clips instead of stock footage) if you decide
  that trade-off is worth it, or add a second free stock source
  (Pixabay, Archive.org) as a fallback before the gradient.
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
- `src/lib/` — LLM (Ollama), stock footage (Pexels), YouTube auth,
  trends, and history-state helpers
- `scripts/get-refresh-token.js` — one-time OAuth helper
- `config/channels.json` — per-channel config
- `data/history-<channel>.json` — auto-generated memory of used topics/videos
- `.github/workflows/pipeline.yml` — cron schedule + Ollama setup, one job per channel

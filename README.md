# YouTube Autopilot

Two parts:

- **`backend/`** — the real automation pipeline. Trend discovery → Claude
  script generation → free TTS voiceover → generated background video →
  ffmpeg assembly → thumbnail → YouTube upload, scheduled via GitHub
  Actions cron with zero human review. Start here: `backend/README.md`.
- **`frontend/`** — a static control-panel dashboard UI (`frontend/index.html`)
  visualizing the pipeline, queue, channels, revenue, and settings. Demo
  data today; see `frontend/README.md` for what it'd take to wire to
  real backend state.

## Pushing this to GitHub

This project isn't connected to git yet. From a terminal, after
downloading and unzipping this folder:

```bash
cd youtube-autopilot
git init
git add .
git commit -m "Initial commit: autopilot backend + dashboard"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

Then follow `backend/README.md` to add your API keys/OAuth tokens as
repo secrets and enable the scheduled workflow.

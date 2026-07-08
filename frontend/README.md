# Autopilot Dashboard (frontend)

A control-panel UI for the automation pipeline in `../backend`: real
video counts, per-channel publish history, the last run's actual
per-stage status (parsed from GitHub Actions job logs), recent workflow
runs, next scheduled cron times, and each channel's real config.

This reads **real backend state**, not demo data - see `build-data.js`.
There's deliberately no revenue KPI: this pipeline has no YouTube
Analytics integration, so a dollar figure here would be fabricated.
There's also no "content queue": this pipeline has no draft/review step,
so `index.html` shows what's actually been published instead of a
simulated backlog.

## Running it

1. `gh auth login` if you haven't (the data script shells out to `gh api`
   for workflow run status - it's the same private repo you're already
   working in, so this just needs to be authenticated once).
2. From this folder: `node build-data.js` - reads
   `../backend/config/channels.json`, `../backend/data/history-*.json`,
   and recent Actions runs, and writes `data.json`.
3. Serve this folder over http:// (fetch() can't read local files from a
   `file://` URL) - e.g. `python3 -m http.server 8099` - and open
   `index.html`. GitHub Pages works the same way for a public deploy;
   just make sure `data.json` exists (run step 2, or wire it into CI)
   before/after each deploy.

Re-run `node build-data.js` any time to refresh - there's no live
polling; "live" here means "as of the last time you ran the script."

# Autopilot Dashboard (frontend)

A static, self-contained control-panel UI for the automation pipeline in
`../backend`: revenue/KPIs, the 7-stage pipeline status, content queue,
per-channel stats, and settings.

This is a **visual dashboard mockup** — it renders demo data and a
simulated live-activity feed client-side; it is not yet wired up to read
real state from the backend (GitHub Actions runs, `data/history-*.json`,
actual YouTube Analytics). Wiring it up would mean adding a small API
(or reading the committed `data/history-*.json` files directly) and
swapping the demo arrays in the page for real fetched data.

## Running it
It's a single self-contained `index.html` — open it directly in a
browser, or serve the folder with GitHub Pages / any static host.

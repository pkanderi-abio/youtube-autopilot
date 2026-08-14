# YouTube Autopilot

Two parts:

- **`backend/`** — the real automation pipeline. Topic discovery (daily
  trends, or a curated evergreen topic pool for channels that define
  one) → local Ollama script generation → free TTS voiceover →
  generated background video (real stock footage via Pexels' free API,
  or a gradient fallback) → ffmpeg assembly → thumbnail → YouTube
  upload, scheduled via GitHub Actions cron with zero human review and
  zero paid APIs. Each channel publishes both short-form and long-form
  videos, each on its own cadence. Start here: `backend/README.md`.
- **`frontend/`** — a control-panel dashboard UI (`frontend/index.html`)
  showing real pipeline/channel state pulled from the backend (publish
  history, last run's actual per-stage status, recent workflow runs).
  See `frontend/README.md` to run it.

## Architecture

```mermaid
flowchart TD

subgraph group_automation["Automation"]
  node_pipeline_workflow{{"Pipeline workflow<br/>GitHub Actions<br/>[pipeline.yml]"}}
  node_analytics_workflow{{"Analytics workflow<br/>GitHub Actions<br/>[analytics.yml]"}}
end

subgraph group_pipeline["Production Pipeline"]
  node_channel_config["Channel configuration<br/>JSON config<br/>[channels.json]"]
  node_orchestrator["Run pipeline<br/>Node.js orchestrator<br/>[run-pipeline.js]"]
  node_state["State handling<br/>State library<br/>[state.js]"]
  node_history[("Channel history<br/>Committed JSON state")]
  node_discovery["Discover topic<br/>Pipeline stage"]
  node_script["Generate script<br/>Pipeline stage"]
  node_seo["Optimize SEO<br/>Pipeline stage<br/>[3-optimize-seo.js]"]
  node_trends_api(("Trend sources<br/>External trends<br/>[trends.js]"))
  node_ollama(("Local Ollama<br/>Local LLM runtime<br/>[llm.js]"))
end

subgraph group_media["Media Runtime"]
  node_voice["Generate voice<br/>Pipeline stage"]
  node_background["Generate background<br/>Pipeline stage"]
  node_assembly["Assemble video<br/>Pipeline stage"]
  node_stock_api(("Pexels API<br/>Stock footage API<br/>[stockFootage.js]"))
  node_media_tools(("TTS and ffmpeg<br/>Local media tools"))
end

subgraph group_publishing["Publishing &amp; Analytics"]
  node_thumbnail["Generate thumbnail<br/>Pipeline stage"]
  node_upload["Upload YouTube<br/>Pipeline stage"]
  node_youtube_api(("YouTube APIs<br/>External publishing API<br/>[youtube.js]"))
  node_analytics_fetch["Fetch analytics<br/>Analytics job<br/>[fetch-analytics.js]"]
  node_analytics_data[("Channel analytics<br/>Committed JSON data")]
end

subgraph group_dashboard["Dashboard"]
  node_dashboard_build["Build dashboard data<br/>Static data builder<br/>[build-data.js]"]
  node_dashboard["Static dashboard<br/>Control panel<br/>[index.html]"]
end

node_pipeline_workflow -->|"runs"| node_orchestrator
node_orchestrator -->|"reads"| node_channel_config
node_orchestrator -->|"uses"| node_state
node_state -->|"updates"| node_history
node_orchestrator -->|"starts"| node_discovery
node_discovery -->|"gets trends"| node_trends_api
node_discovery -->|"topic"| node_script
node_script -->|"generates via"| node_ollama
node_script -->|"script"| node_seo
node_seo -->|"content"| node_voice
node_voice -->|"TTS"| node_media_tools
node_voice -->|"audio"| node_background
node_background -->|"fetches footage"| node_stock_api
node_background -->|"visuals"| node_assembly
node_assembly -->|"ffmpeg"| node_media_tools
node_assembly -->|"video"| node_thumbnail
node_thumbnail -->|"media package"| node_upload
node_upload -->|"publishes"| node_youtube_api
node_analytics_workflow -->|"runs"| node_analytics_fetch
node_analytics_fetch -->|"retrieves metrics"| node_youtube_api
node_analytics_fetch -->|"persists"| node_analytics_data
node_history -->|"supplies state"| node_dashboard_build
node_analytics_data -->|"supplies metrics"| node_dashboard_build
node_dashboard_build -->|"builds data for"| node_dashboard

click node_pipeline_workflow "https://github.com/pkanderi-abio/youtube-autopilot/blob/main/.github/workflows/pipeline.yml"
click node_analytics_workflow "https://github.com/pkanderi-abio/youtube-autopilot/blob/main/.github/workflows/analytics.yml"
click node_channel_config "https://github.com/pkanderi-abio/youtube-autopilot/blob/main/backend/config/channels.json"
click node_orchestrator "https://github.com/pkanderi-abio/youtube-autopilot/blob/main/backend/src/run-pipeline.js"
click node_state "https://github.com/pkanderi-abio/youtube-autopilot/blob/main/backend/src/lib/state.js"
click node_history "https://github.com/pkanderi-abio/youtube-autopilot/blob/main/backend/data/history-channel1.json"
click node_discovery "https://github.com/pkanderi-abio/youtube-autopilot/blob/main/backend/src/steps/1-discover-topic.js"
click node_script "https://github.com/pkanderi-abio/youtube-autopilot/blob/main/backend/src/steps/2-generate-script.js"
click node_seo "https://github.com/pkanderi-abio/youtube-autopilot/blob/main/backend/src/steps/3-optimize-seo.js"
click node_voice "https://github.com/pkanderi-abio/youtube-autopilot/blob/main/backend/src/steps/4-generate-voice.js"
click node_background "https://github.com/pkanderi-abio/youtube-autopilot/blob/main/backend/src/steps/5-generate-background.js"
click node_assembly "https://github.com/pkanderi-abio/youtube-autopilot/blob/main/backend/src/steps/6-assemble-video.js"
click node_thumbnail "https://github.com/pkanderi-abio/youtube-autopilot/blob/main/backend/src/steps/7-generate-thumbnail.js"
click node_upload "https://github.com/pkanderi-abio/youtube-autopilot/blob/main/backend/src/steps/8-upload-youtube.js"
click node_trends_api "https://github.com/pkanderi-abio/youtube-autopilot/blob/main/backend/src/lib/trends.js"
click node_ollama "https://github.com/pkanderi-abio/youtube-autopilot/blob/main/backend/src/lib/llm.js"
click node_stock_api "https://github.com/pkanderi-abio/youtube-autopilot/blob/main/backend/src/lib/stockFootage.js"
click node_youtube_api "https://github.com/pkanderi-abio/youtube-autopilot/blob/main/backend/src/lib/youtube.js"
click node_analytics_fetch "https://github.com/pkanderi-abio/youtube-autopilot/blob/main/backend/scripts/fetch-analytics.js"
click node_analytics_data "https://github.com/pkanderi-abio/youtube-autopilot/blob/main/backend/data/analytics-channel1.json"
click node_dashboard_build "https://github.com/pkanderi-abio/youtube-autopilot/blob/main/frontend/build-data.js"
click node_dashboard "https://github.com/pkanderi-abio/youtube-autopilot/blob/main/frontend/index.html"

classDef toneNeutral fill:#f8fafc,stroke:#334155,stroke-width:1.5px,color:#0f172a
classDef toneBlue fill:#dbeafe,stroke:#2563eb,stroke-width:1.5px,color:#172554
classDef toneAmber fill:#fef3c7,stroke:#d97706,stroke-width:1.5px,color:#78350f
classDef toneMint fill:#dcfce7,stroke:#16a34a,stroke-width:1.5px,color:#14532d
classDef toneRose fill:#ffe4e6,stroke:#e11d48,stroke-width:1.5px,color:#881337
classDef toneIndigo fill:#e0e7ff,stroke:#4f46e5,stroke-width:1.5px,color:#312e81
classDef toneTeal fill:#ccfbf1,stroke:#0f766e,stroke-width:1.5px,color:#134e4a
class node_pipeline_workflow,node_analytics_workflow toneBlue
class node_channel_config,node_orchestrator,node_state,node_history,node_discovery,node_script,node_seo,node_trends_api,node_ollama toneAmber
class node_voice,node_background,node_assembly,node_stock_api,node_media_tools toneMint
class node_thumbnail,node_upload,node_youtube_api,node_analytics_fetch,node_analytics_data toneRose
class node_dashboard_build,node_dashboard toneIndigo
```

## Status

This repo is live: connected to GitHub, public, and running on its
cron schedule (`.github/workflows/pipeline.yml`) with no human
checkpoint. Being public means GitHub Actions minutes are unlimited and
free regardless of schedule — no billing risk. To add a new channel or
change cadence, edit `backend/config/channels.json` and the cron
entries in the workflow file; see `backend/README.md` for the full
setup/config reference.

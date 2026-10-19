// Step 4 - text-to-speech using Microsoft Edge's free, keyless TTS
// engine (via msedge-tts). No API key, no per-character cost - the
// tradeoff is it's an unofficial endpoint that could change; if it
// ever breaks, swap this file for ElevenLabs/Google Cloud TTS.
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { writeFile } from 'fs/promises';

// Default voice - a warm, conversational narrator. The "Multilingual"
// variants are Microsoft's newer conversational-optimized models: same
// speaker identity as the plain -Neural voice, but noticeably less
// robotic delivery (less monotone, better prosody), which the plain
// AndrewNeural voice was getting flagged for. Channels can override
// per-channel via `voice` in channels.json (kids fables uses AvaMultilingual,
// designed as "expressive, caring, pleasant, friendly").
const DEFAULT_VOICE = 'en-US-AndrewMultilingualNeural';

// Edge TTS's default rate is tuned for brisk, efficient information
// delivery, which reads as rushed/flat for narration meant to sound like
// a person talking rather than a screen reader. A modest slowdown gives
// the neural model's own prosody more room to land naturally between
// phrases - this is a starting point, not a measured optimum (unlike the
// retry/JSON-repair fixes elsewhere in this codebase, "sounds human" is
// a subjective call; listen to a sample and adjust if it's not right for
// a given channel's voice).
const DEFAULT_RATE = '-10%';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function generateVoiceOnce(narration, voice, rate) {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioStream } = tts.toStream(narration, { rate });

  const chunks = [];
  await new Promise((resolve, reject) => {
    audioStream.on('data', (c) => chunks.push(c));
    audioStream.on('end', resolve);
    audioStream.on('error', reject);
  });
  return Buffer.concat(chunks);
}

export async function generateVoice(narration, outPath, voice = DEFAULT_VOICE, rate = DEFAULT_RATE) {
  // Unlike every other external call in this pipeline (Gemini, Ollama
  // pull, Pexels footage), this had no retry at all - a single transient
  // WebSocket error against Microsoft's unofficial, undocumented TTS
  // endpoint killed the whole run. Same retry-with-backoff pattern as
  // the rest of the pipeline.
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const buffer = await generateVoiceOnce(narration, voice, rate);
      await writeFile(outPath, buffer);
      return outPath;
    } catch (error) {
      lastError = error;
      console.warn(`[voice] generation failed (attempt ${attempt + 1}/3), retrying: ${error.message}`);
      await sleep(2000 * (attempt + 1));
    }
  }
  throw lastError;
}

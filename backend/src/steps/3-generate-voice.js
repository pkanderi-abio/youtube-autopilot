// Step 3 - text-to-speech using Microsoft Edge's free, keyless TTS
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

export async function generateVoice(narration, outPath, voice = DEFAULT_VOICE) {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
  const { audioStream } = tts.toStream(narration);

  const chunks = [];
  await new Promise((resolve, reject) => {
    audioStream.on('data', (c) => chunks.push(c));
    audioStream.on('end', resolve);
    audioStream.on('error', reject);
  });

  await writeFile(outPath, Buffer.concat(chunks));
  return outPath;
}

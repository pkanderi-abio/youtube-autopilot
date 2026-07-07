// Step 3 - text-to-speech using Microsoft Edge's free, keyless TTS
// engine (via msedge-tts). No API key, no per-character cost - the
// tradeoff is it's an unofficial endpoint that could change; if it
// ever breaks, swap this file for ElevenLabs/Google Cloud TTS.
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import { writeFile } from 'fs/promises';

// A calm, clear neutral narrator voice. Browse more with
// `new MsEdgeTTS().getVoices()` - pick one that fits your channel's tone.
const VOICE = 'en-US-AndrewNeural';

export async function generateVoice(narration, outPath) {
  const tts = new MsEdgeTTS();
  await tts.setMetadata(VOICE, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
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

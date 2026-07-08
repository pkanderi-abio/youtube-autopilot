// CLI entry for a single parallel image-generation job (see the
// generate-images matrix job in .github/workflows/pipeline.yml).
// Self-hosted Stable Diffusion is too slow per-image (tens of minutes
// each on a CPU-only runner) to generate 8-14 scenes serially within
// one job's time budget, so each scene is generated in its own
// concurrent job - total wall-clock time is then bounded by the
// slowest single image, not the sum of all of them.
//
// A failed/missing generation deliberately exits 0 (not 1): the
// "finish" stage (run-pipeline-finish.js) treats a missing image for a
// scene index as "use the gradient fallback for this shot" rather than
// failing the whole video over one bad scene.
// Usage: node src/generate-scene-cli.js <scriptPath> <sceneIndex> <outPath> <width> <height>
import { readFile } from 'fs/promises';
import { generateSceneImage } from './lib/images.js';

async function run(scriptPath, index, outPath, width, height) {
  const script = JSON.parse(await readFile(scriptPath, 'utf8'));
  const prompt = script.scenes?.[index];
  if (!prompt) {
    console.log(`[generate-scene] no scene at index ${index}, nothing to generate`);
    return;
  }

  console.log(`[generate-scene] scene ${index}: ${prompt}`);
  const buffer = await generateSceneImage(prompt, { width: Number(width), height: Number(height) });
  const { writeFile } = await import('fs/promises');
  await writeFile(outPath, buffer);
  console.log(`[generate-scene] wrote ${outPath}`);
}

const [scriptPath, index, outPath, width, height] = process.argv.slice(2);
if (!scriptPath || index === undefined || !outPath || !width || !height) {
  console.error('Usage: node src/generate-scene-cli.js <scriptPath> <sceneIndex> <outPath> <width> <height>');
  process.exit(1);
}

run(scriptPath, index, outPath, width, height).catch((err) => {
  console.warn(`[generate-scene] scene ${index} failed, leaving no output (finish stage falls back to gradient):`, err.message);
  process.exit(0);
});

// Free real-motion AI video: animates the scene images into clips with
// LTX-Video on Kaggle's free GPUs (2x T4, ~30 GPU-hours/week per account).
//
// Flow, one Kaggle round-trip per video:
//   1. scene images + prompts -> private Kaggle dataset (new version)
//   2. push kaggle/ltx_clips.py as a GPU script kernel that mounts it
//   3. poll until the run completes, download clip-NNN.mp4 + result.json
//
// Strictly best-effort: any failure returns no clips and those scenes keep
// the AI still + camera move, so Kaggle problems never block a publish.
//
// Needs secrets KAGGLE_USERNAME + KAGGLE_API_TOKEN (kaggle.com/settings ->
// API -> Generate New Token) on a phone-verified account (Kaggle requires
// that for GPU + internet). CLI: `pip install kaggle` (done in CI).
import { spawn } from 'child_process';
import { mkdir, writeFile, readFile, copyFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import sharp from 'sharp';
import { probeDuration } from './ffmpeg.js';
import { MOCK } from './llm.js';

const USER = process.env.KAGGLE_USERNAME;
const TOKEN = process.env.KAGGLE_API_TOKEN || process.env.KAGGLE_KEY;
const BIN = process.env.KAGGLE_BIN || 'kaggle';
const TIMEOUT_MIN = Number(process.env.KAGGLE_TIMEOUT_MIN || 75);
const MODEL = process.env.LTX_MODEL || 'Lightricks/LTX-Video';
const STEPS = Number(process.env.LTX_STEPS || 30);
const SCRIPT = path.resolve('kaggle/ltx_clips.py');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function kaggleAvailable() {
  return Boolean(USER && TOKEN) && (!MOCK || process.env.KAGGLE_TEST === '1') && process.env.AI_CLIPS !== '0';
}

function kaggle(args, { timeoutMs = 600_000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(BIN, args, { env: { ...process.env, KAGGLE_API_TOKEN: TOKEN } });
    let out = '';
    const timer = setTimeout(() => { p.kill('SIGKILL'); reject(new Error(`kaggle ${args[0]} ${args[1]} timed out`)); }, timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { out += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(out.trim()) : reject(new Error(`kaggle ${args.slice(0, 2).join(' ')} exited ${code}: ${out.trim().slice(-400)}`));
    });
  });
}

const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);

async function uploadDataset(dir, datasetId, runId) {
  let exists = true;
  try { await kaggle(['datasets', 'status', datasetId], { timeoutMs: 60_000 }); } catch { exists = false; }
  if (exists) {
    try {
      await kaggle(['datasets', 'version', '-p', dir, '-m', runId, '-q', '-d']);
    } catch (e) {
      if (!/404|not found|does not exist/i.test(e.message)) throw e;
      await kaggle(['datasets', 'create', '-p', dir, '-q']);
    }
  } else {
    await kaggle(['datasets', 'create', '-p', dir, '-q']);
  }
  // the kernel must not start before the new version is processed
  for (let i = 0; i < 60; i++) {
    const status = await kaggle(['datasets', 'status', datasetId], { timeoutMs: 60_000 }).catch((e) => e.message);
    if (/ready/i.test(status)) return;
    if (/error|failed/i.test(status)) throw new Error(`dataset processing failed: ${status}`);
    await sleep(10_000);
  }
  throw new Error('dataset did not become ready within 10 minutes');
}

async function waitForKernel(kernelId) {
  const deadline = Date.now() + TIMEOUT_MIN * 60_000;
  let last = '';
  while (Date.now() < deadline) {
    await sleep(Number(process.env.KAGGLE_POLL_MS || 30_000));
    const out = await kaggle(['kernels', 'status', kernelId], { timeoutMs: 60_000 }).catch((e) => e.message);
    const status = (out.match(/status "([^"]+)"/)?.[1] || out).toLowerCase();
    if (status !== last) { console.log(`   [kaggle] ${status}`); last = status; }
    if (/complete/.test(status)) return;
    if (/error|cancel/.test(status)) throw new Error(`kernel ${status}: ${out.slice(-300)}`);
  }
  throw new Error(`kernel still running after ${TIMEOUT_MIN} min`);
}

// scenes: [{ index, image, prompt }]. Returns Map(index -> { path, duration }).
export async function generateKaggleClips(scenes, workDir, { name, width, height }) {
  const clips = new Map();
  if (!kaggleAvailable() || !scenes.length) return clips;
  const runId = `${name}-${Date.now()}`;
  const slug = slugify(`ytap-${name}`);
  const datasetId = `${USER}/${slug}-scenes`;
  const kernelSlug = `${slug}-ltx`;
  const kernelId = `${USER}/${kernelSlug}`;
  const base = path.join(workDir, 'kaggle');
  const dsDir = path.join(base, 'dataset');
  const kDir = path.join(base, 'kernel');
  const outDir = path.join(base, 'output');
  await Promise.all([dsDir, kDir, outDir].map((d) => mkdir(d, { recursive: true })));

  try {
    const items = [];
    for (const s of scenes) {
      const file = `scene-${String(s.index).padStart(3, '0')}.jpg`;
      await sharp(s.image).resize(width, height, { fit: 'cover', position: 'attention' }).jpeg({ quality: 92 }).toFile(path.join(dsDir, file));
      items.push({ index: s.index, file, prompt: s.prompt.slice(0, 900) });
    }
    await writeFile(path.join(dsDir, 'manifest.json'), JSON.stringify({
      run_id: runId, width, height, num_frames: 97, steps: STEPS, model: MODEL, dtype: 'fp16',
      max_seconds: (TIMEOUT_MIN - 12) * 60, items
    }, null, 1));
    await writeFile(path.join(dsDir, 'dataset-metadata.json'), JSON.stringify({
      title: `${slug}-scenes`, id: datasetId, licenses: [{ name: 'CC0-1.0' }]
    }));

    const script = (await readFile(SCRIPT, 'utf8')).replace('__RUN_ID__', runId);
    await writeFile(path.join(kDir, 'ltx_clips.py'), script);
    await writeFile(path.join(kDir, 'kernel-metadata.json'), JSON.stringify({
      id: kernelId, title: kernelSlug, code_file: 'ltx_clips.py', language: 'python', kernel_type: 'script',
      is_private: true, enable_gpu: true, enable_internet: true, machine_shape: 'NvidiaTeslaT4',
      dataset_sources: [datasetId], competition_sources: [], kernel_sources: [], model_sources: []
    }));

    console.log(`   [kaggle] uploading ${items.length} scene images...`);
    await uploadDataset(dsDir, datasetId, runId);
    console.log('   [kaggle] starting LTX-Video on free GPU...');
    await kaggle(['kernels', 'push', '-p', kDir, '--accelerator', 'NvidiaTeslaT4']);
    let failed = null;
    try { await waitForKernel(kernelId); } catch (e) { failed = e; }
    // download even on failure: partial clips + result.json + the log are useful
    await kaggle(['kernels', 'output', kernelId, '-p', outDir, '-o', '-q']).catch((e) => { failed ||= e; });

    const resultPath = path.join(outDir, 'result.json');
    const result = existsSync(resultPath) ? JSON.parse(await readFile(resultPath, 'utf8')) : null;
    if (!result || result.run_id !== runId) throw failed || new Error('no result.json for this run');
    for (const c of result.clips) {
      const src = path.join(outDir, c.file);
      if (!existsSync(src)) continue;
      const dest = path.join(workDir, `ltx-${c.file}`);
      await copyFile(src, dest);
      clips.set(c.index, { path: dest, duration: await probeDuration(dest) });
    }
    if (result.errors?.length) console.warn(`   [kaggle] ${result.errors.length} clip error(s): ${result.errors.slice(0, 3).join(' | ')}`);
    if (failed) console.warn(`   [kaggle] run ended early (${failed.message}) - kept ${clips.size} finished clips`);
  } catch (error) {
    console.warn(`[kaggle] AI clips skipped, using stills + motion: ${error.message}`);
    const logFile = path.join(outDir, `${kernelSlug}.log`);
    if (existsSync(logFile)) console.warn((await readFile(logFile, 'utf8')).slice(-1500));
  }
  return clips;
}

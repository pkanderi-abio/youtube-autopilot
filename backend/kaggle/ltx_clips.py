# Runs on a free Kaggle GPU (2x T4) - pushed by src/lib/kaggleClips.js.
# Animates each AI scene image into a short real-motion clip with
# LTX-Video 0.9.8 2B distilled (Lightricks, open weights) image-to-video, then writes clip-NNN.mp4 files
# plus result.json to /kaggle/working for the pipeline to download.
#
# Everything here is best-effort per clip: a failed clip is reported in
# result.json and that scene falls back to the still + camera move.
RUN_ID = "__RUN_ID__"  # replaced by kaggleClips.js on every push

import copy, glob, json, os, subprocess, sys, threading, time, traceback

T0 = time.time()
OUT = "/kaggle/working"
RESULT = {"run_id": RUN_ID, "clips": [], "errors": [], "gpus": 0}


def log(*a):
    print(f"[{time.time() - T0:6.0f}s]", *a, flush=True)


def save():
    with open(os.path.join(OUT, "result.json"), "w") as f:
        json.dump(RESULT, f, indent=1)


def find_manifest():
    for path in glob.glob("/kaggle/input/**/manifest.json", recursive=True):
        try:
            m = json.load(open(path))
            if m.get("run_id") == RUN_ID:
                return m, os.path.dirname(path)
        except Exception:
            pass
    return None, None


manifest, in_dir = find_manifest()
if not manifest:
    RESULT["errors"].append("manifest for this run not found (dataset version not mounted yet?)")
    save()
    sys.exit(0)

log("installing diffusers...")
subprocess.run([sys.executable, "-m", "pip", "install", "-q", "-U",
                "diffusers>=0.32", "transformers>=4.46", "accelerate", "sentencepiece",
                "imageio", "imageio-ffmpeg"], check=True)

import numpy as np
import torch
from PIL import Image, ImageOps
from diffusers import AutoencoderKLLTXVideo, LTXConditionPipeline, LTXVideoTransformer3DModel
from diffusers.utils import export_to_video
from transformers import T5EncoderModel

W, H = int(manifest["width"]), int(manifest["height"])
FRAMES = int(manifest.get("num_frames", 97))  # must be 8n+1
STEPS = int(manifest.get("steps", 30))
MAX_SECONDS = float(manifest.get("max_seconds", 3600))
# Default: LTX-Video 0.9.8 2B distilled - guidance- and timestep-distilled,
# 8 fixed steps with no CFG pass, the fast low-VRAM choice for a free T4.
# Fallback if that single-file checkpoint won't load: the 0.9.5 2B base model.
CHECKPOINT = manifest.get("checkpoint", "https://huggingface.co/Lightricks/LTX-Video/blob/main/ltxv-2b-0.9.8-distilled.safetensors")
BASE_REPO = manifest.get("base_repo", "Lightricks/LTX-Video-0.9.5")
DISTILLED_TIMESTEPS = [1000, 993, 987, 981, 975, 909, 725, 0.03]
NEG = "worst quality, inconsistent motion, blurry, jittery, distorted, deformed, morphing, text, watermark"
dtype = torch.float16 if manifest.get("dtype", "fp16") == "fp16" else torch.bfloat16
items = manifest["items"]
RESULT["gpus"] = torch.cuda.device_count()
log(f"{len(items)} clips at {W}x{H}, {FRAMES} frames, {RESULT['gpus']} GPU(s)")

# T5-XXL overflows in fp16 (NaN embeddings), so the text encoder is loaded in
# bf16 separately; transformer + VAE use `dtype`.
text_encoder = T5EncoderModel.from_pretrained(BASE_REPO, subfolder="text_encoder", torch_dtype=torch.bfloat16)
try:
    transformer = LTXVideoTransformer3DModel.from_single_file(CHECKPOINT, torch_dtype=dtype)
    vae = AutoencoderKLLTXVideo.from_single_file(CHECKPOINT, torch_dtype=dtype)
    pipe = LTXConditionPipeline.from_pretrained(BASE_REPO, transformer=transformer, vae=vae,
                                                text_encoder=text_encoder, torch_dtype=dtype)
    MODE = "distilled"
except Exception as e:
    log("distilled checkpoint failed to load, falling back to the base model:", e)
    RESULT["errors"].append(f"distilled load failed: {e}")
    pipe = LTXConditionPipeline.from_pretrained(BASE_REPO, text_encoder=text_encoder, torch_dtype=dtype)
    MODE = "base"
RESULT["mode"] = MODE
log(f"model mode: {MODE}")

# Encode every prompt once with the (large) T5 text encoder, then drop it so
# only the transformer + VAE need to live on each GPU.
log("encoding prompts...")


def encode_all(device):
    out = {}
    with torch.no_grad():
        for it in items:
            pe, pm, ne, nm = pipe.encode_prompt(prompt=it["prompt"], negative_prompt=NEG,
                                                do_classifier_free_guidance=True, max_sequence_length=256,
                                                device=device, dtype=torch.bfloat16)
            if not (torch.isfinite(pe).all() and torch.isfinite(ne).all()):
                raise RuntimeError("non-finite prompt embeddings")
            out[it["index"]] = (pe.to(dtype).cpu(), pm.cpu(), ne.to(dtype).cpu(), nm.cpu())
    return out


try:
    pipe.text_encoder.to("cuda:0")
    embeds = encode_all("cuda:0")
except Exception as e:  # bf16 kernels can be missing on older GPUs - CPU is slow but works
    log("GPU prompt encoding failed, using CPU:", e)
    pipe.text_encoder.to("cpu")
    torch.cuda.empty_cache()
    embeds = encode_all("cpu")
pipe.text_encoder = None
torch.cuda.empty_cache()

workers = [pipe]
if RESULT["gpus"] > 1:
    try:
        second = LTXConditionPipeline(scheduler=copy.deepcopy(pipe.scheduler), vae=copy.deepcopy(pipe.vae),
                                         text_encoder=None, tokenizer=pipe.tokenizer,
                                         transformer=copy.deepcopy(pipe.transformer))
        workers.append(second)
    except Exception as e:
        log("second GPU disabled:", e)
for i, p in enumerate(workers):
    p.transformer.to(f"cuda:{i}")
    p.vae.to(f"cuda:{i}")
    p.vae.enable_tiling()
    p.set_progress_bar_config(disable=True)


def cover(img):
    return ImageOps.fit(img.convert("RGB"), (W, H), Image.LANCZOS)


def frames_ok(frames):
    mid = np.asarray(frames[len(frames) // 2], dtype=np.float32)
    if mid.std() < 4 or not np.isfinite(mid).all():
        return "blank/NaN frames"
    motion = np.abs(np.asarray(frames[-1], dtype=np.float32) - np.asarray(frames[0], dtype=np.float32)).mean()
    if motion < 0.8:
        return f"no visible motion ({motion:.2f})"
    return None


queue = list(items)
lock = threading.Lock()


def run_worker(wi):
    p = workers[wi]
    dev = f"cuda:{wi}"
    cur_dtype = dtype
    while True:
        with lock:
            if not queue or time.time() - T0 > MAX_SECONDS:
                return
            it = queue.pop(0)
        idx = it["index"]
        started = time.time()
        for attempt in range(2):
            try:
                pe, pm, ne, nm = (t.to(dev) for t in embeds[idx])
                pe, ne = pe.to(cur_dtype), ne.to(cur_dtype)
                sampling = (dict(timesteps=DISTILLED_TIMESTEPS, guidance_scale=1.0, image_cond_noise_scale=0.0)
                            if MODE == "distilled" else
                            dict(num_inference_steps=STEPS, guidance_scale=3.0, image_cond_noise_scale=0.025))
                frames = p(image=cover(Image.open(os.path.join(in_dir, it["file"]))), frame_index=0,
                           prompt_embeds=pe, prompt_attention_mask=pm,
                           negative_prompt_embeds=ne, negative_prompt_attention_mask=nm,
                           width=W, height=H, num_frames=FRAMES, frame_rate=24,
                           decode_timestep=0.05, decode_noise_scale=0.025, **sampling,
                           generator=torch.Generator(device=dev).manual_seed(1000 + idx)).frames[0]
                problem = frames_ok(frames)
                if problem and "blank" in problem and cur_dtype == torch.float16:
                    # fp16 overflow on T4 shows up as black frames - retry in fp32
                    log(f"clip {idx}: {problem} in fp16, retrying in fp32 on {dev}")
                    p.transformer.to(torch.float32)
                    p.vae.to(torch.float32)
                    cur_dtype = torch.float32
                    continue
                if problem:
                    raise RuntimeError(problem)
                name = f"clip-{idx:03d}.mp4"
                export_to_video(frames, os.path.join(OUT, name), fps=24)
                with lock:
                    RESULT["clips"].append({"index": idx, "file": name, "seconds": round(time.time() - started, 1)})
                    save()
                log(f"clip {idx} done on {dev} in {time.time() - started:.0f}s")
                break
            except Exception as e:
                with lock:
                    RESULT["errors"].append(f"clip {idx}: {e}")
                    save()
                log(f"clip {idx} failed: {e}")
                traceback.print_exc()
                break


threads = [threading.Thread(target=run_worker, args=(i,)) for i in range(len(workers))]
for t in threads:
    t.start()
for t in threads:
    t.join()
RESULT["elapsed"] = round(time.time() - T0)
save()
log(f"finished: {len(RESULT['clips'])}/{len(items)} clips")

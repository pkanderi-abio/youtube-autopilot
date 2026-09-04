# Patch: align stock footage with narration

Fixes the reported problem — the stock footage on screen has nothing to do
with what the narrator is saying, and thumbnails show unrelated clips.

## Why it happens (in the current code)

Four independent causes, all in the current `main`:

1. **`scenes` was never tied to the narration.** `2-generate-script.js`
   returns `narration`, `captionLines` and `scenes` as three separate
   arrays. `5-generate-background.js` then calls
   `computeShotDurations(totalDuration, scenes.length)`, which divides the
   runtime into **equal** slices and plays `scenes[i]` during slice `i`.
   Nothing connects `scenes[i]` to the words spoken during slice `i`, so
   the footage drifts from the narration by construction — not by
   accident.

2. **Long-form plans visuals before the script exists.**
   `generateLongScript` gets `scenes` out of `generateScriptOutline`,
   which runs *before* any narration is written. Sections are then
   generated one by one, and can be **skipped on error** and **clamped**
   to a different count (`MAX_LONG_FORM_SECTIONS`). So the visual plan
   describes a script that was never actually produced.

3. **The thumbnail shot was picked at random.**
   `const heroShotIndex = Math.floor(Math.random() * shotCount)`. The
   thumbnail therefore shows a random shot, which is usually not the one
   the title is about.

4. **Footage selection preferred novelty over relevance.**
   `stockFootage.js` picked at random from the top 15 Pexels results to
   avoid downloading the same clip twice. Result #15 for a query is often
   only loosely related, so this fixed duplication by *introducing*
   mismatch.

## What the patch does

Builds the shot list **after** the narration exists, **from** the
narration:

- `captionLines` already cover the narration in order — that's their
  contract — so they're used as the cut points.
- Caption lines are grouped into shots of roughly 6 seconds, and each
  shot's duration is proportional to **its own word count** against the
  real ffprobe-measured audio duration. Shot *i* now covers exactly the
  words spoken during shot *i*.
- One LLM call turns each shot's **actual spoken text** into that shot's
  footage query, with an explicit rule that the phrase must name
  something the narration mentions.
- The thumbnail shot is the shot whose narration overlaps the **title**
  most, instead of a random one.
- Pexels selection is relevance-first: walk results in ranked order and
  take the first whose id isn't in `history.usedClipIds`. De-duplication
  now comes from remembering what was used, not from randomizing the
  pick. If everything ranked has been used, it reuses the best match and
  says so in the log rather than dropping to something unrelated.

Every stage logs its query and the words it belongs to, so the next time
footage looks wrong the CI log shows exactly which shot and query caused
it.

## Files

Drop-in replacements (whole file):

- `src/lib/sceneAlignment.js` — **new**
- `src/lib/stockFootage.js`
- `src/lib/state.js`

Targeted edits below for the two large files.

---

### `src/run-pipeline.js`

**1. Add the import**, next to the other lib imports:

```js
import { buildAlignedShots } from './lib/sceneAlignment.js';
```

**2. Replace the background step.** Find:

```js
    console.log('[5/8] generating background video...');
    const backgroundPath = await generateBackground(channel, duration, workDir, script.scenes || []);
```

Replace with:

```js
    // Shots are built here, not in step 5, because this is the first
    // point where BOTH the finished narration and the real measured
    // audio duration exist - the two things alignment needs.
    console.log('[5/8] aligning shots to narration...');
    const { shots, heroShotIndex } = await buildAlignedShots(channel, script, seo.title, duration);

    console.log('[5/8] generating background video...');
    const background = await generateBackground(channel, duration, workDir, shots, {
      heroShotIndex,
      usedClipIds: history.usedClipIds || []
    });
    const backgroundPath = background.path;
```

**3. Record the clips that were used**, so later videos don't repeat
them. Find:

```js
    history.usedTopics.push(topicInfo.topic);
```

Insert immediately above it:

```js
    history.usedClipIds = (history.usedClipIds || []).concat(background.usedClipIds || []);
```

---

### `src/steps/5-generate-background.js`

**1. Change the export signature.** Find:

```js
export async function generateBackground(channel, durationSeconds, workDir, scenes = []) {
```

Replace with:

```js
// `shots` comes from lib/sceneAlignment.js: [{ text, query, duration }],
// already timed against the real narration. This function no longer
// decides shot count or shot timing - doing that here was the reason
// footage never lined up with what was being said.
export async function generateBackground(channel, durationSeconds, workDir, shots = [], opts = {}) {
```

**2. Use the aligned shot list instead of re-deriving one.** Find:

```js
  const cartoon = channel.visualStyle === 'cartoonAnimation' && scenes.length > 0;
  const stockFootage = channel.visualStyle === 'stockFootage' && scenes.length > 0;
  const shotCount = (cartoon || stockFootage) ? scenes.length : Math.max(3, Math.round(durationSeconds / 7));
  const durations = computeShotDurations(durationSeconds, shotCount);
```

Replace with:

```js
  const cartoon = channel.visualStyle === 'cartoonAnimation' && shots.length > 0;
  const stockFootage = channel.visualStyle === 'stockFootage' && shots.length > 0;
  const shotCount = shots.length || Math.max(3, Math.round(durationSeconds / 7));
  const durations = shots.length
    ? shots.map((s, i) => (i === shots.length - 1 ? s.duration + 0.5 : s.duration))
    : computeShotDurations(durationSeconds, shotCount);
  const scenes = shots.map((s) => s.query);
  const usedClipIds = [];
```

(`computeShotDurations` stays — it's still the fallback when there are no
aligned shots. The `+ 0.5` on the last shot preserves the existing safety
buffer so the background is never shorter than the narration.)

**3. Stop randomizing the thumbnail shot.** Find:

```js
  const heroShotIndex = Math.floor(Math.random() * shotCount);
```

Replace with:

```js
  // Chosen by lib/sceneAlignment.js as the shot whose narration best
  // matches the title, so the thumbnail depicts what the title promises.
  // Randomizing this (the previous behaviour) is why thumbnails so often
  // showed something unrelated to the video.
  const heroShotIndex = Number.isInteger(opts.heroShotIndex)
    ? Math.min(opts.heroShotIndex, shotCount - 1)
    : 0;
```

**4. Record which clip each shot used.** Find:

```js
        const buffer = await findStockFootageClip(scenes[i], { width: w, height: h });
        await writeFile(sourcePath, buffer);
```

Replace with:

```js
        const clip = await findStockFootageClip(scenes[i], {
          width: w, height: h,
          usedClipIds: (opts.usedClipIds || []).concat(usedClipIds)
        });
        await writeFile(sourcePath, clip.buffer);
        usedClipIds.push(clip.clipId);
```

**5. Return the clip ids alongside the video.** Find the end of the
function:

```js
  const bgVideoPath = await concatClips(clipPaths, workDir);
  if (cartoon) {
    await validateCartoonBackground(bgVideoPath, workDir);
  }
  return bgVideoPath;
```

Replace with:

```js
  const bgVideoPath = await concatClips(clipPaths, workDir);
  if (cartoon) {
    await validateCartoonBackground(bgVideoPath, workDir);
  }
  return { path: bgVideoPath, usedClipIds };
```

**6. Cartoon shots should use the spoken text, not the search query.**
The cartoon renderer classifies scene text to decide what to draw, so it
wants the narration, not a stock-search phrase. Find:

```js
        const firstFrame = await cartoonClip(scenes[i] || '', clipPath, workDir, i, w, h, fps, durations[i], shotSeed);
```

Replace with:

```js
        const cartoonText = (shots[i] && (shots[i].text || shots[i].query)) || '';
        const firstFrame = await cartoonClip(cartoonText, clipPath, workDir, i, w, h, fps, durations[i], shotSeed);
```

---

### `src/steps/2-generate-script.js`

The free-floating `scenes` array is now dead weight for narrated videos —
queries are derived from the narration instead. It is still needed for the
**nursery-audio path**, where there is no generated narration to align to.

Minimal change: in `scenesFields`, stop asking for scenes unless the
narration is being skipped. Change `needsScenes`:

```js
function needsScenes(channel) {
  return channel.visualStyle === 'stockFootage';
}
```

to:

```js
// Only the nursery-audio path still needs a pre-planned scene list (it
// has no generated narration for lib/sceneAlignment.js to align to).
// Everything else derives footage queries from the finished narration,
// so asking for scenes here just spends tokens on an array that is
// thrown away - and historically produced the generic, topic-agnostic
// phrases that caused mismatched footage.
function needsScenes(channel, opts = {}) {
  return channel.visualStyle === 'stockFootage' && !!opts.skipNarration;
}
```

Then thread `opts` through to it: `generateScenesOnly` /
`generateScriptOutline` should pass `{ skipNarration: true }`, and the
short/long narrated paths pass nothing. If you'd rather not touch the
plumbing, leaving `needsScenes` as-is is harmless — the extra `scenes`
array is simply ignored for narrated videos.

## Verifying the fix

Run one channel locally and read the `[align]` block in the output — it
prints each shot's duration, its search query, and the narration it
covers:

```
node src/run-pipeline.js channel1 short
```

```
[align] 8 shots aligned to narration (52.4s total):
  shot 1 (6.2s) "aerial view tropical island"  [hero/thumbnail]
     says: "There's an island in Fiji with water so clear you can see 30 feet..."
```

If a query still doesn't match the words under it, the problem is the
query-generation prompt in `sceneAlignment.js` — one place, not four.

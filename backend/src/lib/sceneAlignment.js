// Aligns what is SHOWN with what is SAID.
//
// The bug this fixes: `scenes` was generated as a free-floating array,
// independent of the narration, and step 5 then divided the runtime into
// EQUAL slices (computeShotDurations) and played scene[i] during slice i.
// Nothing tied scene[i] to the words actually spoken during slice i, so
// footage drifted from narration by construction. On long-form it was
// worse: scenes came out of the outline call BEFORE any narration
// existed, and sections could be skipped or clamped afterwards, so the
// visual plan described a script that was never written.
//
// The fix: build shots AFTER narration exists, from the narration itself.
// captionLines already cover the narration in order (that's their
// contract), so they are the natural cut points. Group them into shots of
// roughly TARGET_SHOT_SECONDS, give each shot a duration proportional to
// its own word count against the real measured audio duration, and derive
// each shot's footage query from that shot's own text. Shot i is then
// showing footage of the words being spoken during shot i.
import { completeJSON } from './llm.js';

const TARGET_SHOT_SECONDS = 6;
const MIN_SHOT_SECONDS = 2.5;

function words(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean);
}

// Groups caption lines into shots sized so each lands near
// TARGET_SHOT_SECONDS, using word count as the proxy for speech time.
function groupCaptionLines(captionLines, totalDuration) {
  const lines = captionLines.filter(l => words(l).length);
  if (!lines.length) return [];

  const lineWords = lines.map(l => words(l).length);
  const totalWords = lineWords.reduce((a, b) => a + b, 0);
  const secondsPerWord = totalDuration / totalWords;

  const groups = [];
  let current = { lines: [], wordCount: 0 };
  for (let i = 0; i < lines.length; i++) {
    current.lines.push(lines[i]);
    current.wordCount += lineWords[i];
    const secs = current.wordCount * secondsPerWord;
    const isLast = i === lines.length - 1;
    if (secs >= TARGET_SHOT_SECONDS && !isLast) {
      groups.push(current);
      current = { lines: [], wordCount: 0 };
    }
  }
  if (current.lines.length) {
    // Don't leave a stub final shot - fold it into the previous one.
    const secs = current.wordCount * secondsPerWord;
    if (groups.length && secs < MIN_SHOT_SECONDS) {
      const prev = groups[groups.length - 1];
      prev.lines = prev.lines.concat(current.lines);
      prev.wordCount += current.wordCount;
    } else {
      groups.push(current);
    }
  }

  return groups.map(g => ({
    text: g.lines.join(' '),
    wordCount: g.wordCount,
    duration: g.wordCount * secondsPerWord
  }));
}

// One LLM call for all shots at once, grounded in each shot's actual
// spoken text. Asking per-shot would be N Ollama round-trips for no
// benefit; asking for the whole list keeps the model aware of what the
// neighbouring shots are doing, which reduces repeats.
async function generateQueries(channel, title, shots) {
  const isBaby = channel.contentStyle === 'babyLearning';
  const styleNote = isBaby
    ? `This is content for 1-4 year olds. Every phrase must name a concrete,
brightly-colored object, animal or character that is ACTUALLY MENTIONED in
that shot's narration. Never a generic placeholder like "baby playing with
toys" unless the narration is literally about toys.`
    : `Every phrase must describe something ACTUALLY MENTIONED in that shot's
narration - a place, object, animal, action or setting named in the text.
Never a generic stock phrase that could belong to any video.`;

  const prompt = `
A video titled "${title}" for the channel "${channel.name}" has been cut into
${shots.length} shots. Below is the exact narration spoken during each shot.

${shots.map((s, i) => `Shot ${i + 1}: "${s.text}"`).join('\n\n')}

For EACH shot, write one stock-footage search query describing what should be
on screen while those exact words are spoken.

Rules:
- 3-6 words, concrete nouns, no full sentences (these go into a stock video
  search box).
${styleNote}
- Each query must be clearly DIFFERENT from the others - no two shots should
  search for the same thing.
- If a shot's narration is abstract, pick the most concrete image implied by
  it rather than inventing something unrelated.

Return JSON: { "queries": ["query for shot 1", "query for shot 2", "..."] }
There must be exactly ${shots.length} queries, in order.
`.trim();

  const res = await completeJSON(prompt, { maxTokens: 800 });
  const queries = Array.isArray(res.queries) ? res.queries : [];
  if (queries.length !== shots.length) {
    console.warn(`[align] model returned ${queries.length} queries for ${shots.length} shots - padding/trimming`);
  }
  return shots.map((s, i) => {
    const q = typeof queries[i] === 'string' ? queries[i].trim() : '';
    // Fall back to the shot's own longest words rather than a generic
    // phrase, so a bad model response still searches for something the
    // narration actually said.
    if (q) return q;
    const fallback = words(s.text)
      .filter(w => w.length > 4)
      .slice(0, 4)
      .join(' ');
    return fallback || title;
  });
}

// Picks which shot supplies the thumbnail frame. Previously random,
// which is why thumbnails routinely showed something unrelated to the
// title. Now: the shot whose narration overlaps the title most, so the
// thumbnail depicts the thing the title promises.
function pickHeroShot(title, shots) {
  const titleTokens = new Set(
    words(title.toLowerCase()).map(w => w.replace(/[^a-z0-9]/g, '')).filter(w => w.length > 3)
  );
  let bestIdx = 0;
  let bestScore = -1;
  shots.forEach((s, i) => {
    const shotTokens = words(s.text.toLowerCase()).map(w => w.replace(/[^a-z0-9]/g, ''));
    let overlap = 0;
    for (const t of shotTokens) if (titleTokens.has(t)) overlap++;
    // Prefer real overlap; break ties toward longer shots (more frames
    // to pull a clean thumbnail from).
    const score = overlap * 100 + s.duration;
    if (score > bestScore) { bestScore = score; bestIdx = i; }
  });
  return bestIdx;
}

// Returns { shots: [{ text, query, duration }], heroShotIndex }.
// durationSeconds MUST be the real measured audio duration (ffprobe), not
// an estimate - that's what makes the alignment exact.
export async function buildAlignedShots(channel, script, title, durationSeconds) {
  const captionLines = Array.isArray(script.captionLines) ? script.captionLines : [];

  let grouped = groupCaptionLines(captionLines, durationSeconds);

  // No usable captionLines (e.g. the nursery-audio path, where there is
  // no generated narration at all). Fall back to splitting the runtime
  // evenly and using the pre-planned scene phrases, which is the old
  // behaviour - correct here, because with no narration there is nothing
  // to align to.
  if (!grouped.length) {
    const planned = Array.isArray(script.scenes) ? script.scenes.filter(Boolean) : [];
    const count = planned.length || Math.max(3, Math.round(durationSeconds / TARGET_SHOT_SECONDS));
    const each = durationSeconds / count;
    const shots = Array.from({ length: count }, (_, i) => ({
      text: '',
      query: planned[i] || title,
      duration: each
    }));
    console.log(`[align] no captionLines to align to - using ${count} evenly-timed planned scenes`);
    return { shots, heroShotIndex: 0 };
  }

  const queries = await generateQueries(channel, title, grouped);
  const shots = grouped.map((g, i) => ({ text: g.text, query: queries[i], duration: g.duration }));
  const heroShotIndex = pickHeroShot(title, shots);

  console.log(`[align] ${shots.length} shots aligned to narration (${durationSeconds.toFixed(1)}s total):`);
  shots.forEach((s, i) => {
    const hero = i === heroShotIndex ? ' [hero/thumbnail]' : '';
    console.log(`  shot ${i + 1} (${s.duration.toFixed(1)}s) "${s.query}"${hero}`);
    console.log(`     says: "${s.text.slice(0, 80)}${s.text.length > 80 ? '...' : ''}"`);
  });

  return { shots, heroShotIndex };
}

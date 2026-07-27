// Step 6 - CTR-optimized thumbnail. Studies of high-performing faceless
// YouTube channels (Zack D Films, Bright Side, Infographics Show)
// consistently use the same visual formula: a bold color-block behind
// the title text (not just a dark scrim), 2-3 line title with an
// EMPHASIS word much larger than the rest, an accent icon/emoji, and
// heavy stroke around text for pop on YouTube's dark UI. This step
// implements that formula. Previous version was clean but low-contrast
// - white text on a scrim over a background image - which reads as
// "generic AI thumbnail" against real channels' work.
import { createCanvas, loadImage } from 'canvas';
import { writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';

function wrapText(ctx, text, maxWidth) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const word of words) {
    const test = line ? line + ' ' + word : word;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = word;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

function drawCoverImage(ctx, image, w, h) {
  const scale = Math.max(w / image.width, h / image.height);
  const dw = image.width * scale;
  const dh = image.height * scale;
  ctx.drawImage(image, (w - dw) / 2, (h - dh) / 2, dw, dh);
}

// Bold outlined text - the standard "YouTube thumbnail" look. Renders
// a thick black outline BEHIND the white fill for legibility over any
// background image at any size.
function drawOutlinedText(ctx, text, x, y, { fill = '#ffffff', stroke = '#000000', strokeWidth = 10 } = {}) {
  ctx.lineJoin = 'round';
  ctx.miterLimit = 2;
  ctx.strokeStyle = stroke;
  ctx.lineWidth = strokeWidth;
  ctx.strokeText(text, x, y);
  ctx.fillStyle = fill;
  ctx.fillText(text, x, y);
}

// Rounded rectangle helper - used for the color-block behind text and
// for the corner accent tag.
function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

// Pick the "emphasis word" for the thumbnail - usually the longest,
// most concrete/searchable word in the title. Falls back to the first
// word if nothing stands out. Skips articles/prepositions.
const TITLE_STOPWORDS = new Set([
  'the','a','an','and','or','but','for','to','of','in','on','at','by',
  'with','from','into','over','under','is','are','was','were','how','why',
  'what','when','where','this','that','these','those','it','you','your','our'
]);
function pickEmphasisWord(title) {
  const words = title.split(/\s+/).filter(Boolean);
  // Numbers ALWAYS win, no length filter - "5" is a great emphasis
  // word for "5 Cities to Visit". Check across all words, not just
  // the meaningful set.
  const anyDigit = words.find(w => /\d/.test(w));
  if (anyDigit) return anyDigit;
  const meaningful = words.filter(w => {
    const clean = w.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();
    return clean.length >= 3 && !TITLE_STOPWORDS.has(clean);
  });
  if (meaningful.length === 0) return words[0] || '';
  return meaningful.sort((a, b) => b.length - a.length)[0];
}

// Pick a topical emoji accent for the corner tag. Simple keyword
// heuristic - the specific emoji matters less than "some visual accent
// exists" so viewers' eyes have a bright point to lock onto.
const EMOJI_MAP = [
  [/\b(count|counting|number|\d)\b/i, '🔢'],
  [/\b(sing|song|music|rhyme)\b/i, '🎵'],
  [/\b(star|twinkle|space|planet|galaxy)\b/i, '⭐'],
  [/\b(farm|animal|cow|pig|sheep|duck)\b/i, '🐄'],
  [/\b(color|colors|rainbow|paint)\b/i, '🌈'],
  [/\b(baby|toddler|kids|children)\b/i, '👶'],
  [/\b(food|eat|apple|fruit|snack)\b/i, '🍎'],
  [/\b(travel|beach|destination|island|city)\b/i, '✈️'],
  [/\b(secret|hidden|revealed|truth|why)\b/i, '👀'],
  [/\b(shock|shocking|wild|insane|crazy)\b/i, '🤯'],
  [/\b(top|best|greatest|amazing)\b/i, '🏆'],
  [/\b(history|ancient|old)\b/i, '📜'],
  [/\b(science|nature|earth|world)\b/i, '🌍'],
  [/\b(fire|hot|explosion)\b/i, '🔥']
];
function pickAccentEmoji(title) {
  for (const [re, emoji] of EMOJI_MAP) {
    if (re.test(title)) return emoji;
  }
  return '🎬';
}

// Curated bright accent palette (avoid dull/dark colors that don't pop
// against YouTube's dark theme). Cycles deterministically off the title
// hash so a channel's thumbnails vary without being random per-render.
const ACCENT_COLORS = [
  '#ff2d55', // hot pink/red
  '#ffcc00', // bold yellow
  '#00c853', // vivid green
  '#00b0ff', // sky blue
  '#ff6d00', // bright orange
  '#d500f9'  // magenta
];
function titleHash(title) {
  let h = 0;
  for (let i = 0; i < title.length; i++) h = (h * 31 + title.charCodeAt(i)) | 0;
  return Math.abs(h);
}

export async function generateThumbnail(channel, title, workDir) {
  const w = 1280, h = 720;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');

  // Background: real scene frame if available (from stock footage or
  // cartoon path), else the channel brand gradient.
  const scenePath = path.join(workDir, 'scene-0.png');
  if (existsSync(scenePath)) {
    drawCoverImage(ctx, await loadImage(scenePath), w, h);
  } else {
    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, channel.brandColorA);
    grad.addColorStop(1, channel.brandColorB);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);
  }

  // Slight darkening of the WHOLE frame (not just the bottom scrim) so
  // the brightly-colored text block below has consistent contrast even
  // against a colorful stock photo top-half.
  ctx.fillStyle = 'rgba(0, 0, 0, 0.25)';
  ctx.fillRect(0, 0, w, h);

  // Split the title into an EMPHASIS word (rendered huge in an accent
  // color) and the REST (rendered smaller in white above it). This is
  // the standard high-CTR "big word, small context" pattern.
  const emphasis = pickEmphasisWord(title).toUpperCase();
  const restRaw = title.split(/\s+/)
    .filter((w) => w.toUpperCase() !== emphasis)
    .join(' ')
    .toUpperCase();
  const accent = ACCENT_COLORS[titleHash(title) % ACCENT_COLORS.length];
  const emoji = pickAccentEmoji(title);

  // --- Top block: "REST" in white outlined text ---
  const restSize = 68;
  ctx.font = `900 ${restSize}px sans-serif`;
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  const restLines = wrapText(ctx, restRaw, w - 100).slice(0, 2);
  const restLineHeight = restSize * 1.1;
  const restBlockH = restLines.length * restLineHeight;
  let restY = h * 0.28;
  for (const line of restLines) {
    drawOutlinedText(ctx, line, 60, restY, { fill: '#ffffff', stroke: '#000000', strokeWidth: 10 });
    restY += restLineHeight;
  }

  // --- Bottom block: EMPHASIS word, huge, accent color ---
  // Auto-fit the emphasis word to the width - big and bold is the point.
  let empSize = 220;
  ctx.font = `900 ${empSize}px sans-serif`;
  while (ctx.measureText(emphasis).width > w - 100 && empSize > 90) {
    empSize -= 8;
    ctx.font = `900 ${empSize}px sans-serif`;
  }
  const empY = restY + 30;
  drawOutlinedText(ctx, emphasis, 60, empY, { fill: accent, stroke: '#000000', strokeWidth: 14 });

  // --- Corner accent: emoji in a colored badge, top-right ---
  const badgeSize = 130;
  const badgeX = w - badgeSize - 30;
  const badgeY = 30;
  ctx.fillStyle = accent;
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 6;
  roundRect(ctx, badgeX, badgeY, badgeSize, badgeSize, 22);
  ctx.fill();
  ctx.stroke();
  ctx.font = `${badgeSize * 0.65}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#ffffff';
  ctx.fillText(emoji, badgeX + badgeSize / 2, badgeY + badgeSize / 2 + 8);

  const outPath = path.join(workDir, 'thumbnail.png');
  await writeFile(outPath, canvas.toBuffer('image/png'));
  return outPath;
}

// Step 7 - CTR-optimized thumbnail. Studies of high-performing faceless
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

// Pick a topical accent ICON (not an emoji character) for the corner
// tag. A previous version rendered an emoji glyph directly, which
// depends on the CI runner having an emoji-capable font installed -
// ubuntu-latest doesn't, and a fix attempt (installing fonts-noto-emoji)
// turned out to name a package that doesn't exist, which broke apt-get
// install and took down the entire pipeline for 3 days. Cairo/Pango on
// this runner has independently proven fragile around bitmap/color
// glyph formats before too (see 5-generate-background.js's PNG->JPEG
// cartoon-frame history). Pure vector shapes drawn with canvas
// primitives have zero font dependency and can't silently fail to
// render - same "some bright accent exists" philosophy as the emoji
// version, several categories intentionally share one shape since the
// specific icon matters far less than a bright, distinct accent point.
const ICON_MAP = [
  [/\b(count|counting|number|\d|history|ancient|old|science|nature|earth|world)\b/i, 'circle'],
  [/\b(sing|song|music|rhyme|star|twinkle|space|planet|galaxy|secret|hidden|revealed|truth|why|shock|shocking|wild|insane|crazy|top|best|greatest|amazing)\b/i, 'star'],
  [/\b(farm|animal|cow|pig|sheep|duck|baby|toddler|kids|children)\b/i, 'heart'],
  [/\b(color|colors|rainbow|paint|food|eat|apple|fruit|snack)\b/i, 'flower'],
  [/\b(travel|beach|destination|island|city|fire|hot|explosion)\b/i, 'triangle']
];
function pickAccentIcon(title) {
  for (const [re, icon] of ICON_MAP) {
    if (re.test(title)) return icon;
  }
  return 'circle';
}

// Draws one of a handful of simple vector badge icons, filled + outlined
// to match the emoji badge's original look.
function drawIcon(ctx, icon, cx, cy, r, fill) {
  ctx.fillStyle = fill;
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = Math.max(3, r * 0.12);
  ctx.beginPath();
  if (icon === 'star') {
    for (let i = 0; i < 10; i++) {
      const rr = i % 2 === 0 ? r : r * 0.42;
      const angle = -Math.PI / 2 + i * (Math.PI / 5);
      const x = cx + Math.cos(angle) * rr;
      const y = cy + Math.sin(angle) * rr;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  } else if (icon === 'heart') {
    ctx.moveTo(cx, cy + r * 0.3);
    ctx.bezierCurveTo(cx + r, cy - r * 0.6, cx + r * 1.5, cy + r * 0.3, cx, cy + r);
    ctx.bezierCurveTo(cx - r * 1.5, cy + r * 0.3, cx - r, cy - r * 0.6, cx, cy + r * 0.3);
    ctx.closePath();
  } else if (icon === 'flower') {
    for (let i = 0; i < 5; i++) {
      const angle = (i / 5) * Math.PI * 2;
      const px = cx + Math.cos(angle) * r * 0.55;
      const py = cy + Math.sin(angle) * r * 0.55;
      ctx.moveTo(px + r * 0.4, py);
      ctx.arc(px, py, r * 0.4, 0, Math.PI * 2);
    }
  } else if (icon === 'triangle') {
    ctx.moveTo(cx, cy - r);
    ctx.lineTo(cx + r * 0.87, cy + r * 0.5);
    ctx.lineTo(cx - r * 0.87, cy + r * 0.5);
    ctx.closePath();
  } else {
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
  }
  ctx.fill();
  ctx.stroke();
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

// Renders one thumbnail composition to a PNG buffer. `flip` swaps the
// standard "small text on top, huge emphasis word on bottom" layout for
// "huge emphasis word on top, smaller text below" with the accent badge
// moved to the opposite corner and a different accent color - a real
// compositional difference, not just a recolor, so the two variants this
// step produces are an actual A/B choice rather than noise.
function renderVariant(channel, title, sceneImage, { flip, accentIndex }) {
  const w = 1280, h = 720;
  const canvas = createCanvas(w, h);
  const ctx = canvas.getContext('2d');

  if (sceneImage) {
    drawCoverImage(ctx, sceneImage, w, h);
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
  // color) and the REST (rendered smaller in white). This is the
  // standard high-CTR "big word, small context" pattern.
  const emphasis = pickEmphasisWord(title).toUpperCase();
  const restRaw = title.split(/\s+/)
    .filter((w) => w.toUpperCase() !== emphasis)
    .join(' ')
    .toUpperCase();
  const accent = ACCENT_COLORS[accentIndex % ACCENT_COLORS.length];
  const icon = pickAccentIcon(title);

  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';

  // Measured once up front (font size depends on text width), but NOT
  // relied on as leftover ctx.font state afterward - every draw call
  // below sets ctx.font itself immediately before use. A previous
  // version left ctx.font at this (huge, ~220px) size after the auto-fit
  // loop and the non-flip branch drew the smaller "rest" text without
  // resetting it first, rendering that text at emphasis size and
  // producing badly overlapping lines on every uploaded thumbnail
  // (confirmed directly against a live upload: "RABBITS"/"OVERRUN" text
  // overlapping into an unreadable jumble).
  let empSize = 220;
  ctx.font = `900 ${empSize}px sans-serif`;
  while (ctx.measureText(emphasis).width > w - 100 && empSize > 90) {
    empSize -= 8;
    ctx.font = `900 ${empSize}px sans-serif`;
  }

  const restSize = 68;
  const restLineHeight = restSize * 1.1;

  function drawRestBlock(startY) {
    ctx.font = `900 ${restSize}px sans-serif`;
    const restLines = wrapText(ctx, restRaw, w - 100).slice(0, 2);
    let y = startY;
    for (const line of restLines) {
      drawOutlinedText(ctx, line, 60, y, { fill: '#ffffff', stroke: '#000000', strokeWidth: 10 });
      y += restLineHeight;
    }
    return y;
  }

  function drawEmphasisBlock(y) {
    ctx.font = `900 ${empSize}px sans-serif`;
    drawOutlinedText(ctx, emphasis, 60, y, { fill: accent, stroke: '#000000', strokeWidth: 14 });
  }

  if (flip) {
    // EMPHASIS word first (top), REST below it.
    const empY = h * 0.22;
    drawEmphasisBlock(empY);
    drawRestBlock(empY + empSize * 1.05 + 20);
  } else {
    // REST first (top, smaller), EMPHASIS word below it (bigger) - the
    // original/default composition.
    const afterRestY = drawRestBlock(h * 0.28);
    drawEmphasisBlock(afterRestY + 30);
  }

  // --- Corner accent: vector icon in a colored badge, opposite corner per variant ---
  const badgeSize = 130;
  const badgeX = flip ? 30 : w - badgeSize - 30;
  const badgeY = 30;
  ctx.fillStyle = accent;
  ctx.strokeStyle = '#000000';
  ctx.lineWidth = 6;
  roundRect(ctx, badgeX, badgeY, badgeSize, badgeSize, 22);
  ctx.fill();
  ctx.stroke();
  drawIcon(ctx, icon, badgeX + badgeSize / 2, badgeY + badgeSize / 2, badgeSize * 0.32, '#ffffff');

  return canvas.toBuffer('image/png');
}

// Produces two thumbnail candidates - `primary` (what actually gets
// uploaded via youtube.thumbnails.set, since the Data API only accepts
// one) and `variantB` (saved alongside it for manual review/swap in
// YouTube Studio). This is a deliberately lightweight stand-in for real
// A/B testing: the Data API doesn't expose Studio's "Test & compare"
// feature for programmatic control, so there's no way to actually run a
// live split test end-to-end here - but having a genuinely different
// second composition on hand costs almost nothing to generate and gives
// a real choice instead of just one guess.
export async function generateThumbnail(channel, title, workDir) {
  const scenePath = path.join(workDir, 'scene-0.png');
  const sceneImage = existsSync(scenePath) ? await loadImage(scenePath) : null;
  const baseAccent = titleHash(title) % ACCENT_COLORS.length;

  const primaryBuf = renderVariant(channel, title, sceneImage, { flip: false, accentIndex: baseAccent });
  const variantBuf = renderVariant(channel, title, sceneImage, { flip: true, accentIndex: baseAccent + 1 });

  const primaryPath = path.join(workDir, 'thumbnail.png');
  const variantBPath = path.join(workDir, 'thumbnail-b.png');
  await writeFile(primaryPath, primaryBuf);
  await writeFile(variantBPath, variantBuf);

  return { primary: primaryPath, variantB: variantBPath };
}

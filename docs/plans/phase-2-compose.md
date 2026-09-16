# Phase 2.6 Composition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `lantern compose --post <id> --formats square,pin` renders a post's quote card over its public-domain portrait, at exactly 1200x1200 and 1000x1500, writing one `renditions` row per format and rewriting `posts.alt_text`.

**Architecture:** Text is laid out glyph by glyph with opentype.js against fonts committed in `assets/fonts/`, emitted as an SVG overlay of closed glyph outlines placed by transform, and composited by sharp over the cover-cropped portrait. The stage mirrors `mediaVertical`: an options object, a report with per-item outcomes, a typed-error allowlist, and unexpected errors aborting the run.

**Tech Stack:** Node 26, TypeScript (strict, nodenext, `noUncheckedIndexedAccess`, `verbatimModuleSyntax`), vitest, better-sqlite3, zod, commander, sharp 0.35.4, opentype.js 2.0.0.

**Spec:** `claude.md` (sections 4, 6, 7, 10, 11) and `plan.md` milestone 2.6.

## Global Constraints

- **No migration.** `renditions` and its `idx_renditions_post_status` index have both existed since `migrations/001_initial.sql` (lines 95-111 and 160). Do not add one; a duplicate `CREATE INDEX` fails the moment `testDb()` migrates.
- **Every non-ASCII character in a `.ts` file must be a `\u` escape.** Prefer avoiding them: the card's typographic quotation marks are written `String.fromCharCode(0x201c)`. Lines added to `.yaml` and `.sql` stay ASCII. The existing non-ASCII in `claude.md`, `plan.md` and `src/config/schema.ts` must not be re-encoded.
- **Relative imports carry `.js` extensions** and type-only imports use `import type` (`nodenext` + `verbatimModuleSyntax`).
- **Exact dimensions:** `square` is 1200x1200 aspect `1:1`; `pin` is 1000x1500 aspect `2:3` (spec section 11).
- **Refuse rather than shrink:** a quote that will not fit at 40px fails that format and writes no `renditions` row. `local_path` is `NOT NULL` and must name a file that exists.
- **Stored paths use forward slashes**, matching `images.local_path`; `join()` is only for absolute filesystem paths.
- Tests make no network requests and use no API key.
- Commit messages end with the two trailers shown in each commit step, and nothing under `data/`, `logs/` or `.env` is ever committed.

---

### Task 1: Dependencies, bundled fonts, and the glyph emitter

The emitter is the whole milestone's foundation and carries two rules that were paid for in corrupted cards. Read the doc comment in `src/compose/text.ts` before changing anything in it.

**Files:**
- Modify: `package.json`, `.gitattributes`
- Create: `assets/fonts/Lora.ttf`, `assets/fonts/Lora-OFL.txt`, `assets/fonts/WorkSans.ttf`, `assets/fonts/WorkSans-OFL.txt`
- Create: `src/compose/text.ts`
- Test: `tests/compose/text.test.ts`

**Interfaces:**
- Produces: `loadFont(path): Font`, `glyphOutline(font, glyph): string`, `measure(font, text, size): number`, `trackedWidth(font, text, size, tracking): number`, `wrapText(font, text, size, maxWidth): string[]`, `fitText(font, text, box, sizes, lineHeight): FittedText | null`, `textPaths(font, text, x, baseline, size, fill, tracking?): string`, `centeredPaths(font, lines, size, centerX, firstBaseline, lineHeight, fill): string`, and the types `Font`, `TextBox`, `FittedText`.

- [ ] **Step 1: Install the two runtime dependencies and the typings**

`opentype.js` ships no TypeScript declarations, so `@types/opentype.js` is required or `text.ts` will not compile.

```bash
npm install sharp@0.35.4 opentype.js@2.0.0
npm install --save-dev @types/opentype.js
```

- [ ] **Step 2: Mark the fonts binary in `.gitattributes`**

The repo sets `* text=auto eol=lf`. Git's heuristics would almost certainly classify a `.ttf` as binary, but "almost certainly" is not what should stand between a committed font and a corrupted one when a pre-push gate counts CR bytes.

```
* text=auto eol=lf
data/cache/** -text
assets/fonts/*.ttf -text
```

- [ ] **Step 3: Add the fonts and their licences**

Copy the four files into `assets/fonts/`. They are the variable OFL builds from google/fonts; each licence file sits beside its font.

| File | Bytes | sha256 |
|---|---|---|
| `assets/fonts/Lora.ttf` | 212196 | `822a6621ccbe8d97d20ac88c1c41f5615c9c2c202eaa75f272cd452aac6475a7` |
| `assets/fonts/WorkSans.ttf` | 361072 | `f50f61f2ba738e239442d40bf1069adb195c224b6a5a73a581fc2f3ed62a9f63` |
| `assets/fonts/Lora-OFL.txt` | 4423 | |
| `assets/fonts/WorkSans-OFL.txt` | 4396 | |

Both fonts are well under the 500 KB pre-push blob limit. Verify after copying:

```bash
sha256sum assets/fonts/*.ttf
```

- [ ] **Step 4: Write the failing test**

The third case is the one that matters most: the cache bug it guards against produced plausible-looking output and was only caught by looking at a rendered card.

```ts
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { fitText, glyphOutline, loadFont, measure, trackedWidth, wrapText } from '../../src/compose/text.js';

const FONTS = fileURLToPath(new URL('../../assets/fonts/', import.meta.url));
const lora = loadFont(`${FONTS}Lora.ttf`);
const workSans = loadFont(`${FONTS}WorkSans.ttf`);

describe('glyphOutline', () => {
  it('closes every contour it emits', () => {
    // An unclosed contour is filled by joining it to the next one with a straight line, which turns a
    // letter's counter into a blob. Letters with counters are the ones that show it first.
    for (const character of 'abdegopq') {
      const data = glyphOutline(lora, lora.charToGlyph(character));
      const moves = (data.match(/M/g) ?? []).length;
      const closes = (data.match(/Z/g) ?? []).length;
      expect(moves, `${character} should draw at least one contour`).toBeGreaterThan(0);
      expect(closes, `${character} should close every contour it opens`).toBe(moves);
    }
  });

  it('emits outlines in font units, so the same letter is identical wherever it is placed', () => {
    const first = glyphOutline(lora, lora.charToGlyph('e'));
    const second = glyphOutline(lora, lora.charToGlyph('e'));
    expect(second).toBe(first);
    // Font units, not card coordinates: a 1000-unit em never produces four-digit card positions here.
    expect(first.startsWith('M')).toBe(true);
  });

  it('gives each font its own outlines', () => {
    // Glyph indices mean different letters in different fonts, and opentype.js reports no family name
    // for either of these, so a cache keyed by name once drew Lora's w wherever Work Sans asked for d.
    const loraD = glyphOutline(lora, lora.charToGlyph('d'));
    const workSansD = glyphOutline(workSans, workSans.charToGlyph('d'));
    expect(workSansD).not.toBe(loraD);

    // The indices really do collide: this is the exact pair that produced "Priwe anw Prejuwice".
    expect(workSans.charToGlyph('d').index).toBe(lora.charToGlyph('w').index);
    expect(glyphOutline(workSans, workSans.charToGlyph('d'))).not.toBe(glyphOutline(lora, lora.charToGlyph('w')));
  });

  it('emits nothing for a space', () => {
    expect(glyphOutline(lora, lora.charToGlyph(' '))).toBe('');
  });
});

describe('measure', () => {
  it('scales with the size and grows with the text', () => {
    const small = measure(lora, 'It was the best of times', 40);
    const large = measure(lora, 'It was the best of times', 80);
    expect(large).toBeCloseTo(small * 2, 5);
    expect(measure(lora, 'It was the best of times, it was the worst of times', 40)).toBeGreaterThan(small);
    expect(measure(lora, '', 40)).toBe(0);
  });

  it('adds letterspacing between glyphs but not after the last', () => {
    const plain = measure(workSans, 'BOOK', 20);
    expect(trackedWidth(workSans, 'BOOK', 20, 5)).toBeCloseTo(plain + 15, 5);
    expect(trackedWidth(workSans, 'B', 20, 5)).toBeCloseTo(measure(workSans, 'B', 20), 5);
  });
});

describe('wrapText', () => {
  it('never lets a line exceed the width it was given', () => {
    const quote = 'It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness';
    const lines = wrapText(lora, quote, 48, 900);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(measure(lora, line, 48)).toBeLessThanOrEqual(900);
    expect(lines.join(' ')).toBe(quote);
  });

  it('keeps a word that cannot fit rather than dropping it', () => {
    const lines = wrapText(lora, 'incomprehensibilities', 48, 10);
    expect(lines).toEqual(['incomprehensibilities']);
  });
});

describe('fitText', () => {
  const SIZES = [72, 60, 48, 40] as const;

  it('picks the largest size that fits the box', () => {
    const roomy = fitText(lora, 'Truth is stranger than fiction.', { width: 1000, height: 500 }, SIZES, 1.34);
    expect(roomy?.size).toBe(72);

    const tight = fitText(lora, 'Truth is stranger than fiction.', { width: 400, height: 200 }, SIZES, 1.34);
    expect(tight).not.toBeNull();
    expect(tight?.size).toBeLessThan(72);
  });

  it('refuses rather than shrinking below the smallest size', () => {
    // Failing the rendition is the point: a quote set smaller than this is illegible as a thumbnail.
    const quote = 'It was the best of times, it was the worst of times, it was the age of wisdom, it was the age of foolishness, '.repeat(6);
    expect(fitText(lora, quote, { width: 900, height: 500 }, SIZES, 1.34)).toBeNull();
  });
});
```

- [ ] **Step 5: Run it to make sure it fails**

Run: `npx vitest run tests/compose/text.test.ts`
Expected: FAIL, cannot resolve `../../src/compose/text.js`.

- [ ] **Step 6: Write the emitter**

```ts
import { readFileSync } from 'node:fs';
import opentype from 'opentype.js';

export type Font = opentype.Font;

/**
 * Loads a bundled font file. The fonts ship with the repo under assets/fonts/ so a card depends on
 * nothing the machine has installed: the same quote renders identically on every machine.
 */
export function loadFont(path: string): Font {
  return opentype.parse(new Uint8Array(readFileSync(path)).buffer);
}

/**
 * The glyph's outline in font units, with every contour explicitly closed.
 *
 * Two rules here were paid for in corrupted cards, and neither is optional:
 *
 * 1. opentype.js's toSVG() never emits a Z command, so each contour is left open. librsvg closes
 *    those subpaths implicitly, and once the coordinates are large card-space numbers it mis-fills
 *    them: counters fill solid and stems lose contours. The path data is therefore built from the
 *    commands and every contour is closed here.
 * 2. The outline is emitted in font units and positioned by the caller with a transform, never by
 *    baking the position into each coordinate with getPath(x, y, size). Keeping the numbers small
 *    renders whole, makes every occurrence of a letter byte-identical, and cuts the SVG by a third.
 *
 * The cache is keyed by the font object itself. Glyph indices mean different letters in different
 * fonts (no letter index is shared between Lora and Work Sans), and opentype.js reports
 * names.fontFamily as undefined for both, so a cache keyed by name silently draws one font's
 * outlines for another's indices.
 */
const outlines = new WeakMap<Font, Map<number, string>>();

const round = (value: number): number => Number(value.toFixed(2));

export function glyphOutline(font: Font, glyph: opentype.Glyph): string {
  let perFont = outlines.get(font);
  if (perFont === undefined) {
    perFont = new Map<number, string>();
    outlines.set(font, perFont);
  }
  const cached = perFont.get(glyph.index);
  if (cached !== undefined) return cached;

  const parts: string[] = [];
  let open = false;
  for (const command of glyph.getPath(0, 0, font.unitsPerEm).commands) {
    if (command.type === 'M') {
      if (open) parts.push('Z');
      parts.push(`M${round(command.x)} ${round(command.y)}`);
      open = true;
    } else if (command.type === 'L') {
      parts.push(`L${round(command.x)} ${round(command.y)}`);
    } else if (command.type === 'Q') {
      parts.push(`Q${round(command.x1)} ${round(command.y1)} ${round(command.x)} ${round(command.y)}`);
    } else if (command.type === 'C') {
      parts.push(`C${round(command.x1)} ${round(command.y1)} ${round(command.x2)} ${round(command.y2)} ${round(command.x)} ${round(command.y)}`);
    } else {
      parts.push('Z');
      open = false;
    }
  }
  if (open) parts.push('Z');

  const data = parts.join('');
  perFont.set(glyph.index, data);
  return data;
}

const glyphsOf = (font: Font, text: string): opentype.Glyph[] => [...text].map((character) => font.charToGlyph(character));

/**
 * The advance width of a string at a size, kerning included. Every fit decision measures with this,
 * so what the layout believes and what the renderer draws cannot drift apart.
 *
 * opentype.js's own string APIs are not used anywhere in this module: they run OpenType feature
 * substitution and throw "substitutionType : 62 lookupType: 6" on these fonts. Laying out glyph by
 * glyph loses ligatures, which a quote card can afford.
 */
export function measure(font: Font, text: string, size: number): number {
  const glyphs = glyphsOf(font, text);
  let units = 0;
  for (const [index, glyph] of glyphs.entries()) {
    units += glyph.advanceWidth ?? 0;
    const next = glyphs[index + 1];
    if (next !== undefined) units += font.getKerningValue(glyph, next);
  }
  return (units * size) / font.unitsPerEm;
}

/** The width of letterspaced text, which the wordmark needs: tracking adds a gap after every glyph but the last. */
export function trackedWidth(font: Font, text: string, size: number, tracking: number): number {
  return measure(font, text, size) + tracking * Math.max(0, [...text].length - 1);
}

/** Greedy line breaking on measured widths. Nothing is drawn before it is known to fit. */
export function wrapText(font: Font, text: string, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let line = '';
  for (const word of text.split(/\s+/).filter((word) => word !== '')) {
    const candidate = line === '' ? word : `${line} ${word}`;
    if (measure(font, candidate, size) <= maxWidth || line === '') line = candidate;
    else {
      lines.push(line);
      line = word;
    }
  }
  if (line !== '') lines.push(line);
  return lines;
}

export interface TextBox {
  width: number;
  height: number;
}

export interface FittedText {
  size: number;
  lines: string[];
}

/**
 * The largest size at which the text fits its box, or null when even the smallest does not.
 *
 * Returning null is the point: the card refuses the rendition rather than shrinking type to
 * something illegible on a phone (spec section 10, and plan 2.6's "fail the rendition rather than
 * shrink to illegibility").
 */
export function fitText(font: Font, text: string, box: TextBox, sizes: readonly number[], lineHeight: number): FittedText | null {
  for (const size of sizes) {
    const lines = wrapText(font, text, size, box.width);
    if (lines.length * size * lineHeight <= box.height) return { size, lines };
  }
  return null;
}

/** One SVG path element per glyph, placed on the baseline by transform. Spaces emit nothing. */
export function textPaths(font: Font, text: string, x: number, baseline: number, size: number, fill: string, tracking = 0): string {
  const glyphs = glyphsOf(font, text);
  const scale = size / font.unitsPerEm;
  const parts: string[] = [];
  let pen = x;
  for (const [index, glyph] of glyphs.entries()) {
    const data = glyphOutline(font, glyph);
    if (data !== '') {
      parts.push(`<path transform="translate(${pen.toFixed(2)} ${baseline.toFixed(2)}) scale(${scale.toFixed(6)})" d="${data}" fill="${fill}"/>`);
    }
    pen += (glyph.advanceWidth ?? 0) * scale + tracking;
    const next = glyphs[index + 1];
    if (next !== undefined) pen += font.getKerningValue(glyph, next) * scale;
  }
  return parts.join('\n  ');
}

/** Lines centred on an x axis, each on its own baseline. */
export function centeredPaths(
  font: Font,
  lines: readonly string[],
  size: number,
  centerX: number,
  firstBaseline: number,
  lineHeight: number,
  fill: string,
): string {
  return lines
    .map((line, index) => textPaths(font, line, centerX - measure(font, line, size) / 2, firstBaseline + index * size * lineHeight, size, fill))
    .join('\n  ');
}
```

- [ ] **Step 7: Run the tests**

Run: `npx vitest run tests/compose/text.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json .gitattributes assets/fonts src/compose/text.ts tests/compose/text.test.ts
git commit -m "feat(compose): bundle Lora and Work Sans and lay text out glyph by glyph

Emits each glyph once in font units with every contour closed and places it
with a transform. opentype.js emits no closing command, and librsvg mis-fills
the open subpaths at card scale: counters fill solid and letters disappear.
The outline cache is keyed by the font object, because glyph indices mean
different letters in different fonts.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
```

---

### Task 2: Formats and the card template

**Files:**
- Create: `src/compose/formats.ts`, `src/compose/template.ts`

**Interfaces:**
- Consumes: everything Task 1 produces.
- Produces: `IMAGE_FORMATS`, `IMAGE_FORMAT_NAMES`, `isImageFormat(value)`, types `FormatSpec` and `ImageFormat`; `cardLayout(format, fonts, text): CardLayout`, `QUOTE_SIZES`, `TextTooLongError`, types `CardFonts`, `CardText`, `CardLayout`.

- [ ] **Step 1: Add the format table**

`IMAGE_RENDITION_FORMATS` is added to `src/config/schema.ts` in Task 3; this file imports only the `RenditionFormat` type, which already exists.

```ts
import type { RenditionFormat } from '../config/schema.js';

export interface FormatSpec {
  /** The exact pixel width every rendition of this format has. */
  width: number;
  /** The exact pixel height every rendition of this format has. */
  height: number;
  aspect: string;
}

/**
 * The image formats this stage composes, with the exact dimensions from the rendition matrix in
 * spec section 11. Video formats (`short`) belong to the render stage in phase 8, and `portrait`
 * and `landscape` are not built until the channels that need them exist, so asking for either is
 * an error rather than a silently empty run.
 */
export const IMAGE_FORMATS = {
  square: { width: 1200, height: 1200, aspect: '1:1' },
  pin: { width: 1000, height: 1500, aspect: '2:3' },
} as const satisfies Partial<Record<RenditionFormat, FormatSpec>>;

export type ImageFormat = keyof typeof IMAGE_FORMATS;

export const IMAGE_FORMAT_NAMES = Object.keys(IMAGE_FORMATS) as ImageFormat[];

export function isImageFormat(value: string): value is ImageFormat {
  return Object.hasOwn(IMAGE_FORMATS, value);
}
```

- [ ] **Step 2: Add the card template**

`cardLayout` throws `TextTooLongError` rather than setting a quote below 40px. The quotation marks are code points so the file stays ASCII, and the quote's own characters never reach the markup, because every character is a path.

```ts
import type { FormatSpec } from './formats.js';
import type { Font } from './text.js';
import { centeredPaths, fitText, textPaths, trackedWidth } from './text.js';

/**
 * Typographic quotation marks, written as code points so every line of this file stays ASCII.
 * The quote itself is published verbatim (spec section 8), so the marks are added around it here
 * rather than by editing the stored text.
 */
const OPEN_QUOTE = String.fromCharCode(0x201c);
const CLOSE_QUOTE = String.fromCharCode(0x201d);

/** The smallest the quote is ever set: below this the card stops being readable as a phone thumbnail. */
const SMALLEST_QUOTE_SIZE = 40;
/** Sizes are tried largest first; a quote that will not fit at the smallest fails the rendition. */
export const QUOTE_SIZES = [72, 66, 60, 54, 48, 44, SMALLEST_QUOTE_SIZE] as const;
const LINE_HEIGHT = 1.34;

/**
 * The shared margin system, as fractions of the card's width or height, so one template serves
 * every format by adapting rather than letterboxing (spec section 10).
 */
const MARGIN = 0.09;
const QUOTE_BOX_HEIGHT = 0.44;
const META_SIZE = 0.028;
const META_GAP = 0.035;
const WORK_GAP = 1.95;
const AUTHOR_SCALE = 1.15;
const MARK_SIZE = 0.019;
const MARK_TRACKING = 0.006;
const FOOT_BAND = 0.6;

/** One palette for both brands' cards: warm off-white on a dark scrim. */
const SCRIM = '#101114';
const QUOTE_INK = '#f6f3ec';
const WORK_INK = '#c9c2b4';
const MARK_INK = '#b5a992';

export interface CardFonts {
  /** The serif the quotation is set in. */
  quote: Font;
  /** The sans the author, the work and the wordmark are set in. */
  meta: Font;
}

export interface CardText {
  quote: string;
  author: string;
  /** The work and its year, already formatted for display. */
  work: string;
  wordmark: string;
}

/** A quote that cannot be set legibly at the smallest size. The rendition fails; it is never shrunk further. */
export class TextTooLongError extends Error {
  override name = 'TextTooLongError';
}

export interface CardLayout {
  svg: string;
  /** The size the quote was set at, for the run log: a card at 40px is a card worth looking at. */
  quoteSize: number;
  quoteLines: string[];
}

/**
 * The overlay for one card: a scrim over the whole photograph, a stronger band at the foot, the
 * quotation, the author, the work, and the wordmark on the bottom margin.
 *
 * Every character is emitted as a glyph outline, never as an SVG text element, so the card depends
 * on the bundled fonts rather than on whatever fonts the renderer happens to find. That also means
 * the quote's own characters never reach the markup, so no XML escaping is needed or possible to
 * get wrong.
 */
export function cardLayout(format: FormatSpec, fonts: CardFonts, text: CardText): CardLayout {
  const { width, height } = format;
  const margin = Math.round(width * MARGIN);
  const box = { width: width - margin * 2, height: Math.round(height * QUOTE_BOX_HEIGHT) };

  const quoted = `${OPEN_QUOTE}${text.quote}${CLOSE_QUOTE}`;
  const laid = fitText(fonts.quote, quoted, box, QUOTE_SIZES, LINE_HEIGHT);
  if (laid === null) {
    throw new TextTooLongError(
      `the quote needs more than ${Math.floor(box.height / (SMALLEST_QUOTE_SIZE * LINE_HEIGHT))} lines at ${SMALLEST_QUOTE_SIZE}px, so it cannot be set legibly`,
    );
  }

  // The block is centred on the card rather than pinned near the top, so short quotes do not float.
  const blockHeight = laid.lines.length * laid.size * LINE_HEIGHT;
  const metaSize = Math.round(width * META_SIZE);
  const metaBlock = metaSize * AUTHOR_SCALE + metaSize * WORK_GAP;
  const top = Math.round((height - blockHeight - metaBlock) / 2) + laid.size;
  const metaTop = top + blockHeight + Math.round(height * META_GAP);
  const markSize = Math.round(width * MARK_SIZE);
  const tracking = width * MARK_TRACKING;
  const bandTop = Math.round(height * FOOT_BAND);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">
  <rect width="${width}" height="${height}" fill="${SCRIM}" fill-opacity="0.60"/>
  <rect y="${bandTop}" width="${width}" height="${height - bandTop}" fill="${SCRIM}" fill-opacity="0.30"/>
  ${centeredPaths(fonts.quote, laid.lines, laid.size, width / 2, top, LINE_HEIGHT, QUOTE_INK)}
  ${centeredPaths(fonts.meta, [text.author], metaSize * AUTHOR_SCALE, width / 2, metaTop, 1.3, QUOTE_INK)}
  ${centeredPaths(fonts.meta, [text.work], metaSize, width / 2, metaTop + metaSize * WORK_GAP, 1.3, WORK_INK)}
  ${textPaths(
    fonts.meta,
    text.wordmark,
    width / 2 - trackedWidth(fonts.meta, text.wordmark, markSize, tracking) / 2,
    height - margin,
    markSize,
    MARK_INK,
    tracking,
  )}
</svg>`;

  return { svg, quoteSize: laid.size, quoteLines: laid.lines };
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add src/compose/formats.ts src/compose/template.ts
git commit -m "feat(compose): add the rendition format table and the card template

One template adapts per aspect rather than letterboxing: a scrim over the whole
photograph, a stronger band at the foot, the quotation centred, then the author,
the work and the letterspaced wordmark on the bottom margin.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
```

---

### Task 3: Config section and database access

**Files:**
- Modify: `src/config/schema.ts`, `config/verticals/literature.yaml`, `src/db/posts.ts`, `src/db/images.ts`
- Create: `src/db/renditions.ts`

**Interfaces:**
- Produces: `composeSchema`, `IMAGE_RENDITION_FORMATS`, types `ComposeConfig` and `ImageRenditionFormat`; `postToCompose(db, postId)`, `updateAltText(db, postId, altText)`; `postImage(db, postId)` and type `PostImage`; `upsertRendition(db, rendition, now?)`, `postRenditions(db, postId)`, types `NewRendition` and `StoredRendition`.

- [ ] **Step 1: Add the compose section to the vertical schema**

`verticalSchema` is a `strictObject`, so the schema and the YAML must change together or `loadConfig` throws. The format list is restricted to the two formats this stage can render, so asking for a phase-8 video format fails at config load rather than deep inside the stage.

```ts
import { z } from 'zod';

export const PLATFORMS = ['facebook', 'pinterest', 'youtube', 'instagram', 'tiktok'] as const;
export const RENDITION_FORMATS = ['square', 'portrait', 'pin', 'short', 'landscape'] as const;
/** The formats the compose stage can actually render; the rest are video or wait for the channels that need them. */
export const IMAGE_RENDITION_FORMATS = ['square', 'pin'] as const;
export type Platform = (typeof PLATFORMS)[number];
export type RenditionFormat = (typeof RENDITION_FORMATS)[number];

const slug = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'must be a lowercase kebab-case slug');
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'must be HH:MM (24h)');

export const harvestAuthorSchema = z
  .strictObject({
    name: z.string().min(1),
    /** Exactly as Gutendex lists the author ("Surname, Given"); matched with the years to set authorMatches. */
    gutendex_name: z.string().regex(/^[^,]+, [^,]+$/, 'must be "Surname, Given" as Gutendex lists it'),
    wikidata_id: z.string().regex(/^Q[1-9]\d*$/, 'must be a Wikidata Q-number'),
    birth_year: z.number().int(),
    death_year: z.number().int(),
  })
  .refine((a) => a.death_year >= a.birth_year, { message: 'death_year must not be before birth_year', path: ['death_year'] });

export const harvestSchema = z.strictObject({
  authors: z.array(harvestAuthorSchema).min(1),
  picker: z.strictObject({
    model: z.string().min(1),
    batch_size: z.number().int().min(10).max(500),
    max_batches_per_work: z.number().int().min(1).max(50),
    picks_per_batch: z.number().int().min(1).max(10),
  }),
});

export const enrichSchema = z.strictObject({
  /** Writes each draft and its one revision. */
  writer_model: z.string().min(1),
  /** Checks every sentence of a draft against the paragraphs it cites. */
  checker_model: z.string().min(1),
  /** The most characters of paragraphs offered to the writer from the author's Wikipedia article. */
  author_article_chars: z.number().int().min(1000).max(100_000),
  /** The same for the work's article. */
  work_article_chars: z.number().int().min(1000).max(100_000),
});

export const composeSchema = z.strictObject({
  /** The serif the quotation is set in, named relative to assets/fonts/. */
  quote_font: z.string().min(1),
  /** The sans the author, the work and the wordmark are set in. */
  meta_font: z.string().min(1),
  /** The page name as it appears on every card. The public name is still open (spec section 3), so it lives here, not in code. */
  wordmark: z.string().min(1),
  /** The formats composed for this vertical by default. */
  formats: z.array(z.enum(IMAGE_RENDITION_FORMATS)).min(1),
  /** JPEG quality for composed cards; the platforms re-encode anyway, so this buys size, not fidelity. */
  jpeg_quality: z.number().int().min(60).max(100),
});

export const verticalSchema = z
  .strictObject({
    slug,
    name: z.string().min(1),
    kid_safe: z.boolean(),
    audience: z.strictObject({
      reading_level: z.string().regex(/^grade-\d{1,2}$/).optional(),
      age_range: z.tuple([z.number().int(), z.number().int()]).optional(),
    }),
    voice: z.string().min(1),
    post_shape: z.strictObject({ hook: z.string(), body: z.string(), closer: z.string() }),
    banned_topics: z.array(z.string().min(1)).default([]),
    image: z.strictObject({
      style: z.string().min(1),
      generated_disclosure: z.literal(true),
    }),
    harvest: harvestSchema.optional(),
    enrich: enrichSchema.optional(),
    compose: composeSchema.optional(),
  })
  .superRefine((v, ctx) => {
    if (v.kid_safe && (!v.audience.reading_level || v.banned_topics.length === 0)) {
      ctx.addIssue({
        code: 'custom',
        path: ['kid_safe'],
        message: 'kid_safe verticals require audience.reading_level and at least one banned_topics entry',
      });
    }
  });

export const channelSchema = z
  .strictObject({
    vertical: slug,
    platform: z.enum(PLATFORMS),
    handle: z.string().min(1).optional(),
    account_ref: z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'must be an env var NAME, not a value'),
    formats: z.array(z.enum(RENDITION_FORMATS)).min(1),
    cadence: z.strictObject({
      posts_per_day: z.number().int().min(1).max(2),
      times: z.array(hhmm).min(1),
    }),
    made_for_kids: z.boolean().optional(),
    caption: z.strictObject({
      title_max: z.number().int().positive().optional(),
      text_max: z.number().int().positive(),
    }),
  })
  .superRefine((c, ctx) => {
    if (c.cadence.times.length !== c.cadence.posts_per_day) {
      ctx.addIssue({
        code: 'custom',
        path: ['cadence', 'times'],
        message: `must list exactly posts_per_day (${c.cadence.posts_per_day}) times`,
      });
    }
    if (c.platform === 'youtube' && c.made_for_kids === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['made_for_kids'],
        message: 'youtube channels must set made_for_kids explicitly (spec §11)',
      });
    }
  });

export type VerticalConfig = z.infer<typeof verticalSchema>;
export type ChannelConfig = z.infer<typeof channelSchema>;
export type HarvestConfig = z.infer<typeof harvestSchema>;
export type EnrichConfig = z.infer<typeof enrichSchema>;
export type ComposeConfig = z.infer<typeof composeSchema>;
export type ImageRenditionFormat = (typeof IMAGE_RENDITION_FORMATS)[number];
```

- [ ] **Step 2: Add the compose block to the literature vertical**

Added lines stay ASCII; the existing non-ASCII on lines 2 and 6 must not be re-encoded.

```yaml
slug: literature
name: The Commonplace Book          # working name — see spec §3 / §16
kid_safe: false
audience: {}
voice: |
  Warm, precise, quietly enthusiastic — a well-read friend, not a lecturer.
  Say who wrote it, what was happening in their life and the world when they
  did, and what the line actually means. Every claim traces to a stored source.
  Never: inspirational-poster tone, invented anecdotes, "timeless wisdom" filler.
post_shape:
  hook: 1 sentence
  body: 2-4 short paragraphs
  closer: 1 sentence pointing back to the work itself
banned_topics: []
image:
  style: public-domain author portrait, title page, manuscript page, or period image of the setting
  generated_disclosure: true
harvest:
  # Wikidata years equal Gutendex's author years; both must match for authorMatches (spec section 8).
  authors:
    - { name: Charles Dickens, gutendex_name: "Dickens, Charles", wikidata_id: Q5686, birth_year: 1812, death_year: 1870 }
    - { name: Jane Austen, gutendex_name: "Austen, Jane", wikidata_id: Q36322, birth_year: 1775, death_year: 1817 }
    - { name: Mark Twain, gutendex_name: "Twain, Mark", wikidata_id: Q7245, birth_year: 1835, death_year: 1910 }
    - { name: Oscar Wilde, gutendex_name: "Wilde, Oscar", wikidata_id: Q30875, birth_year: 1854, death_year: 1900 }
  picker:
    model: claude-sonnet-5        # user's choice, 2026-09-13
    batch_size: 150               # candidates per Claude call (~45 input tokens each)
    max_batches_per_work: 6       # spend cap per book
    picks_per_batch: 3            # most sentences the model may choose from one batch
enrich:
  writer_model: claude-opus-5         # user's choice, 2026-09-15
  checker_model: claude-sonnet-5      # user's choice, 2026-09-15
  author_article_chars: 30000         # Wikipedia paragraphs offered to the writer, per article
  work_article_chars: 18000
compose:
  quote_font: Lora.ttf                # user's choice, 2026-09-15
  meta_font: WorkSans.ttf             # user's choice, 2026-09-15
  wordmark: THE COMMONPLACE BOOK      # working name, so it lives in config (spec sections 3 and 16)
  formats: [square, pin]
  jpeg_quality: 90                    # the platforms re-encode anyway; q90 keeps cards small without marking the type
```

- [ ] **Step 3: Add the rendition writer**

`UNIQUE(post_id, format)` is what makes a re-run safe, so the upsert is keyed on that pair and replaces one format's row only.

```ts
import type { Db } from './connection.js';

export interface NewRendition {
  postId: number;
  format: string;
  /** Images here; video renditions belong to the render stage in phase 8. */
  mediaType: 'image';
  aspect: string;
  width: number;
  height: number;
  /** Where the composed file is kept, relative to the media directory. */
  localPath: string;
  bytes: number;
  status: 'ready' | 'failed';
  error: string | null;
}

export interface StoredRendition {
  id: number;
  format: string;
  localPath: string;
  width: number;
  height: number;
  bytes: number | null;
  status: string;
}

/**
 * Writes one format's rendition, replacing the row that format already has.
 *
 * The table's UNIQUE(post_id, format) makes this the natural shape: re-running compose regenerates
 * a format and replaces that row only, leaving every other format untouched (spec section 7). The
 * row is keyed on the pair, so a post can never accumulate two rows for the same format.
 */
export function upsertRendition(db: Db, rendition: NewRendition, now: Date = new Date()): number {
  db.prepare(
    `INSERT INTO renditions (post_id, format, media_type, aspect, width, height, local_path, bytes, status, error, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(post_id, format) DO UPDATE SET
       media_type = excluded.media_type,
       aspect = excluded.aspect,
       width = excluded.width,
       height = excluded.height,
       local_path = excluded.local_path,
       bytes = excluded.bytes,
       status = excluded.status,
       error = excluded.error,
       created_at = excluded.created_at`,
  ).run(
    rendition.postId,
    rendition.format,
    rendition.mediaType,
    rendition.aspect,
    rendition.width,
    rendition.height,
    rendition.localPath,
    rendition.bytes,
    rendition.status,
    rendition.error,
    now.toISOString(),
  );
  return db.prepare('SELECT id FROM renditions WHERE post_id = ? AND format = ?').pluck().get(rendition.postId, rendition.format) as number;
}

/** Every rendition a post has, for the review UI and for deciding what compose still owes it. */
export function postRenditions(db: Db, postId: number): StoredRendition[] {
  return db
    .prepare(
      `SELECT id, format, local_path AS localPath, width, height, bytes, status
       FROM renditions
       WHERE post_id = ?
       ORDER BY format`,
    )
    .all(postId) as StoredRendition[];
}
```

- [ ] **Step 4: Add the post lookup and the alt-text writer**

`postToCompose` and `updateAltText` are new; everything else in this file is unchanged.

```ts
import type { SourceInput } from '../verify/source-policy.js';
import type { Db } from './connection.js';
import { insertSource } from './sources.js';

/** After this many failed attempts a quote is no longer offered to enrich, unless a run asks to retry failed quotes. */
export const MAX_ENRICH_FAILURES = 3;

export interface ItemToEnrich {
  itemId: number;
  subjectId: number;
  body: string;
  workTitle: string;
  author: string;
  wikidataId: string;
}

export interface ItemsToEnrichOptions {
  /** Also offer quotes that have already failed MAX_ENRICH_FAILURES times. */
  retryFailed?: boolean;
}

/**
 * Verified quotes in a vertical with no post yet, at most `limit`, with their author.
 *
 * Quotes with fewer recorded failures come first, so a quote that always fails cannot hold back new
 * ones, and a quote that has failed MAX_ENRICH_FAILURES times is left out unless `retryFailed`. Within
 * that, subjects take turns: every subject's oldest waiting quote comes before any subject's second, so
 * a small limit still mixes authors. Quotes without a work title or an author Wikidata id cannot be
 * given sources and are not returned; harvest always records both.
 */
export function itemsToEnrich(db: Db, verticalId: number, limit: number, options: ItemsToEnrichOptions = {}): ItemToEnrich[] {
  return db
    .prepare(
      `SELECT itemId, subjectId, body, workTitle, author, wikidataId FROM (
         SELECT i.id AS itemId, s.id AS subjectId, i.body AS body, i.work_title AS workTitle, s.name AS author, s.wikidata_id AS wikidataId,
                (SELECT COUNT(*) FROM enrich_failures f WHERE f.item_id = i.id) AS failures,
                ROW_NUMBER() OVER (PARTITION BY i.subject_id ORDER BY i.id) AS turn
         FROM items i JOIN subjects s ON s.id = i.subject_id
         WHERE i.vertical_id = ? AND i.kind = 'quote' AND i.status = 'verified'
           AND i.work_title IS NOT NULL AND s.wikidata_id IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.item_id = i.id)
       )
       WHERE ? = 1 OR failures < ?
       ORDER BY failures, turn, subjectId, itemId
       LIMIT ?`,
    )
    .all(verticalId, options.retryFailed === true ? 1 : 0, MAX_ENRICH_FAILURES, limit) as ItemToEnrich[];
}

/** Records one failed attempt to write a post for a quote. */
export function recordEnrichFailure(db: Db, itemId: number, reason: string, now: Date = new Date()): void {
  db.prepare('INSERT INTO enrich_failures (item_id, reason, failed_at) VALUES (?, ?, ?)').run(itemId, reason, now.toISOString());
}

/** Verified quotes without a post that are no longer offered because they failed MAX_ENRICH_FAILURES times. */
export function countGivenUp(db: Db, verticalId: number): number {
  return db
    .prepare(
      `SELECT COUNT(*) FROM items i
       WHERE i.vertical_id = ? AND i.kind = 'quote' AND i.status = 'verified'
         AND NOT EXISTS (SELECT 1 FROM posts p WHERE p.item_id = i.id)
         AND (SELECT COUNT(*) FROM enrich_failures f WHERE f.item_id = i.id) >= ?`,
    )
    .pluck()
    .get(verticalId, MAX_ENRICH_FAILURES) as number;
}

export interface PostToCompose {
  postId: number;
  verticalId: number;
  /** Null until the media stage has given the post an image; compose has nothing to compose without one. */
  imageId: number | null;
  status: string;
  /** The quotation, exactly as the source prints it (spec section 8). */
  body: string;
  workTitle: string;
  workYear: number | null;
  author: string;
}

/** The one post a compose run is about, with the quotation and the work it comes from. */
export function postToCompose(db: Db, postId: number): PostToCompose | undefined {
  return db
    .prepare(
      `SELECT p.id AS postId, p.vertical_id AS verticalId, p.image_id AS imageId, p.status,
              i.body AS body, i.work_title AS workTitle, i.work_year AS workYear, s.name AS author
       FROM posts p
       JOIN items i ON i.id = p.item_id
       JOIN subjects s ON s.id = i.subject_id
       WHERE p.id = ?`,
    )
    .get(postId) as PostToCompose | undefined;
}

/**
 * Rewrites a post's alt text once its card exists. Enrich writes a placeholder from the quote alone;
 * the composed card is what a reader actually sees, so this stage owns the description (plan 2.6).
 */
export function updateAltText(db: Db, postId: number, altText: string): boolean {
  return db.prepare('UPDATE posts SET alt_text = ? WHERE id = ?').run(altText, postId).changes === 1;
}

export interface PostRound {
  round: 1 | 2;
  draft: unknown;
  check: unknown;
  /** Every problem the gates found in this round; empty when it passed. */
  problems: string[];
  writerModel: string;
  checkerModel: string;
  /** sha256 of the round's writer system prompt, a blank line, and the checker's system prompt. */
  promptSha256: string;
}

export interface PostSource {
  /** The label the drafts cite it by (S1, S2, ...). */
  label: string;
  source: SourceInput;
  retrievedAt: Date;
}

export interface NewPost {
  itemId: number;
  verticalId: number;
  hook: string;
  /** Body paragraphs separated by a blank line. */
  body: string;
  closer: string;
  altText: string;
  status: 'draft' | 'needs_review';
  rounds: PostRound[];
  sources: PostSource[];
}

/** A post that would break the enrichment rules: nothing was written. */
export class PostRuleError extends Error {
  override name = 'PostRuleError';
}

/**
 * Inserts a post with its rounds and cited sources in one transaction. The quote must be verified
 * (spec section 2.1), the rounds must be numbered from 1 in order, and a 'draft' post's last round must
 * have no problems (spec section 2.6). Each cited paragraph becomes a source of the quote (spec section
 * 2.2: every claim traces to a stored source), reusing an identical source row the quote already has,
 * and is linked to the post under its label.
 */
export function insertPost(db: Db, post: NewPost, now: Date = new Date()): number {
  return db.transaction((): number => {
    const status = db.prepare('SELECT status FROM items WHERE id = ?').pluck().get(post.itemId) as string | undefined;
    if (status !== 'verified') throw new PostRuleError(`item ${post.itemId} is ${status ?? 'missing'}, not verified`);
    const last = post.rounds[post.rounds.length - 1];
    if (last === undefined) throw new PostRuleError('a post needs at least one round');
    if (post.rounds.some((r, i) => r.round !== i + 1)) throw new PostRuleError('rounds must be numbered from 1, in order');
    if (post.status === 'draft' && last.problems.length > 0) throw new PostRuleError('a draft post cannot have problems in its last round');

    const postId = Number(
      db
        .prepare('INSERT INTO posts (item_id, vertical_id, hook, body, closer, alt_text, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
        .run(post.itemId, post.verticalId, post.hook, post.body, post.closer, post.altText, post.status, now.toISOString()).lastInsertRowid,
    );
    const existing = db
      .prepare('SELECT id FROM sources WHERE item_id = ? AND tier = ? AND url IS ? AND citation = ? AND excerpt IS ? ORDER BY id LIMIT 1')
      .pluck();
    const link = db.prepare('INSERT INTO post_sources (post_id, source_id, label) VALUES (?, ?, ?)');
    for (const { label, source, retrievedAt } of post.sources) {
      const found = existing.get(post.itemId, source.tier, source.url ?? null, source.citation, source.excerpt ?? null) as number | undefined;
      link.run(postId, found ?? insertSource(db, post.itemId, source, retrievedAt), label);
    }
    const round = db.prepare(
      'INSERT INTO post_rounds (post_id, round, draft_json, check_json, problems_json, writer_model, checker_model, prompt_sha256, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    for (const r of post.rounds) {
      round.run(
        postId,
        r.round,
        JSON.stringify(r.draft),
        JSON.stringify(r.check),
        JSON.stringify(r.problems),
        r.writerModel,
        r.checkerModel,
        r.promptSha256,
        now.toISOString(),
      );
    }
    return postId;
  })();
}
```

- [ ] **Step 5: Add the post-image join**

`postImage` is new. This step also repairs the doubled `/**` that opened `postsNeedingImage`'s doc comment.

```ts
import type { ImageLicense } from '../media/commons.js';
import type { Db } from './connection.js';

export interface NewImage {
  subjectId: number;
  /** Where the file came from (spec section 6); Commons is the only origin this stage uses. */
  origin: 'wikimedia';
  /** The file url, without any tracking query. */
  sourceUrl: string;
  /** The Commons file page, which shows the licence and the credit. */
  filePageUrl: string;
  license: ImageLicense;
  /** The creator as Commons states it, or null when it names none. */
  attribution: string | null;
  /** Where the original is kept, relative to the media directory. */
  localPath: string;
  width: number;
  height: number;
  mime: string;
  bytes: number;
  sha256: string;
}

export interface StoredImage {
  id: number;
  sourceUrl: string;
  localPath: string;
  license: string;
}

/** Inserts the image, or returns the row this subject already has for that source url (a re-run downloads nothing). */
export function insertImage(db: Db, image: NewImage, now: Date = new Date()): number {
  const existing = db.prepare('SELECT id FROM images WHERE subject_id = ? AND source_url = ?').pluck().get(image.subjectId, image.sourceUrl) as
    | number
    | undefined;
  if (existing !== undefined) return existing;
  return Number(
    db
      .prepare(
        `INSERT INTO images (subject_id, origin, source_url, file_page_url, license, attribution, local_path, width, height, mime, bytes, sha256, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        image.subjectId,
        image.origin,
        image.sourceUrl,
        image.filePageUrl,
        image.license,
        image.attribution,
        image.localPath,
        image.width,
        image.height,
        image.mime,
        image.bytes,
        image.sha256,
        now.toISOString(),
      ).lastInsertRowid,
  );
}

/** The image already stored for a subject, if any: the same portrait is reused for all of that subject's posts. */
export function subjectImage(db: Db, subjectId: number): StoredImage | undefined {
  return db
    .prepare('SELECT id, source_url AS sourceUrl, local_path AS localPath, license FROM images WHERE subject_id = ? ORDER BY id LIMIT 1')
    .get(subjectId) as StoredImage | undefined;
}

export interface PostNeedingImage {
  postId: number;
  itemId: number;
  subjectId: number;
  subjectSlug: string;
  author: string;
  wikidataId: string;
}

/**
 * Posts of a vertical that have no image yet, oldest first. Only a draft or a post waiting for review is
 * offered: an approved post is what a human approved, picture and all, and a rejected one will never be
 * published (spec sections 5 and 10). A subject without a Wikidata id cannot be looked up and is left
 * out; countPostsWithoutSubjectId reports those, so they are never a silent skip (spec section 2.6).
 */
export function postsNeedingImage(db: Db, verticalId: number, limit: number): PostNeedingImage[] {
  return db
    .prepare(
      `SELECT p.id AS postId, i.id AS itemId, s.id AS subjectId, s.slug AS subjectSlug, s.name AS author, s.wikidata_id AS wikidataId
       FROM posts p
       JOIN items i ON i.id = p.item_id
       JOIN subjects s ON s.id = i.subject_id
       WHERE p.vertical_id = ? AND p.image_id IS NULL AND p.status IN ('draft', 'needs_review') AND s.wikidata_id IS NOT NULL
       ORDER BY p.id
       LIMIT ?`,
    )
    .all(verticalId, limit) as PostNeedingImage[];
}

/** Posts that would be offered an image but for a subject with no Wikidata id, so a run can say they exist. */
export function countPostsWithoutSubjectId(db: Db, verticalId: number): number {
  return db
    .prepare(
      `SELECT COUNT(*)
       FROM posts p
       JOIN items i ON i.id = p.item_id
       LEFT JOIN subjects s ON s.id = i.subject_id
       WHERE p.vertical_id = ? AND p.image_id IS NULL AND p.status IN ('draft', 'needs_review')
         AND (s.id IS NULL OR s.wikidata_id IS NULL)`,
    )
    .pluck()
    .get(verticalId) as number;
}

export interface PostImage {
  imageId: number;
  /** Where the original is kept, relative to the media directory. */
  localPath: string;
  license: string;
  /** The creator as Commons states it, or null when it names none. */
  attribution: string | null;
  /** The subject the portrait is of, which the card prints and the alt text describes. */
  author: string;
  subjectSlug: string;
}

/**
 * The image attached to a post, with the credit the card and its alt text need. Returns undefined
 * when the post has no image yet, which is the compose stage's signal that media has not run for it.
 */
export function postImage(db: Db, postId: number): PostImage | undefined {
  return db
    .prepare(
      `SELECT im.id AS imageId, im.local_path AS localPath, im.license, im.attribution, s.name AS author, s.slug AS subjectSlug
       FROM posts p
       JOIN images im ON im.id = p.image_id
       JOIN items i ON i.id = p.item_id
       JOIN subjects s ON s.id = i.subject_id
       WHERE p.id = ?`,
    )
    .get(postId) as PostImage | undefined;
}

/** Links an image to a post that has none. Returns false when the post already has one: an image is never replaced. */
export function attachImage(db: Db, postId: number, imageId: number): boolean {
  return db.prepare('UPDATE posts SET image_id = ? WHERE id = ? AND image_id IS NULL').run(imageId, postId).changes === 1;
}
```

- [ ] **Step 6: Type-check and run the existing suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean, and every existing test still passes (the schema gained an optional key, so config tests must be unaffected).

- [ ] **Step 7: Commit**

```bash
git add src/config/schema.ts config/verticals/literature.yaml src/db/renditions.ts src/db/posts.ts src/db/images.ts
git commit -m "feat(compose): add the compose config section and its database access

The wordmark text lives in config so the still-open page name can change without
touching code. Renditions upsert on UNIQUE(post_id, format), so regenerating one
format replaces that row and leaves every other format alone.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
```

---

### Task 4: The compose stage

**Files:**
- Create: `src/compose/compose.ts`
- Test: `tests/compose/compose.test.ts`

**Interfaces:**
- Consumes: everything Tasks 1-3 produce.
- Produces: `composePost(options): Promise<ComposeReport>`, `renditionPath(postId, format)`, `workLine(post)`, `composeAltText(post, image)`, `ComposeError`, types `ComposeOptions`, `FormatOutcome`, `FormatReport`, `ComposeReport`.

- [ ] **Step 1: Write the failing test**

The fixture needs a real, decodable image, because sharp has to read and crop it; the repo has none, so it is generated with sharp in `beforeEach`. Items are inserted `raw` and the vertical, subject and image are reused when a test seeds a second post, since their slugs and source url are unique.

```ts
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import { beforeEach, describe, expect, it } from 'vitest';
import { ComposeError, composeAltText, composePost, renditionPath, workLine } from '../../src/compose/compose.js';
import type { ComposeConfig } from '../../src/config/schema.js';
import type { Db } from '../../src/db/connection.js';
import type { PostImage } from '../../src/db/images.js';
import type { PostToCompose } from '../../src/db/posts.js';
import { testDb } from '../helpers/db.js';

const NOW = new Date('2026-09-15T12:00:00Z');
const FONTS = fileURLToPath(new URL('../../assets/fonts/', import.meta.url));
const CONFIG: ComposeConfig = {
  quote_font: 'Lora.ttf',
  meta_font: 'WorkSans.ttf',
  wordmark: 'THE COMMONPLACE BOOK',
  formats: ['square', 'pin'],
  jpeg_quality: 90,
};
const QUOTE = 'It was the best of times, it was the worst of times.';
const SOURCE = 'source/charles-dickens-portrait.jpg';
const PLACEHOLDER = 'the placeholder enrich wrote';

let db: Db;
let mediaDir: string;
let postId: number;
let seq: number;

/**
 * A post with an image already attached, which is the state the media stage leaves behind.
 *
 * A test may seed more than one post, so the vertical, the subject and the image are reused when
 * they already exist: their slugs and source url are unique, and one portrait serving all of an
 * author's posts is how the media stage actually behaves.
 */
function seed(quote = QUOTE, withImage = true): number {
  const id = (sql: string, ...params: unknown[]) => Number(db.prepare(sql).run(...params).lastInsertRowid);
  const pick = (sql: string, ...params: unknown[]) => db.prepare(sql).pluck().get(...params) as number | undefined;

  const verticalId =
    pick("SELECT id FROM verticals WHERE slug = 'literature'") ??
    id("INSERT INTO verticals (slug, name, config_path) VALUES ('literature', 'The Commonplace Book', 'config/verticals/literature.yaml')");
  const subjectId =
    pick('SELECT id FROM subjects WHERE vertical_id = ? AND slug = ?', verticalId, 'charles-dickens') ??
    id(
      "INSERT INTO subjects (vertical_id, kind, name, slug, wikidata_id, created_at) VALUES (?, 'author', 'Charles Dickens', 'charles-dickens', 'Q5686', ?)",
      verticalId,
      NOW.toISOString(),
    );
  // Items are inserted raw and promoted once they have sources; a guard trigger refuses anything else.
  const itemId = id(
    `INSERT INTO items (vertical_id, subject_id, kind, body, body_hash, work_title, work_year, status, created_at)
     VALUES (?, ?, 'quote', ?, ?, 'A Tale of Two Cities', 1859, 'raw', ?)`,
    verticalId,
    subjectId,
    quote,
    `hash-${++seq}`,
    NOW.toISOString(),
  );
  const imageId = withImage
    ? (pick('SELECT id FROM images WHERE subject_id = ?', subjectId) ??
      id(
        `INSERT INTO images (subject_id, origin, source_url, file_page_url, license, attribution, local_path, width, height, mime, bytes, sha256, created_at)
         VALUES (?, 'wikimedia', 'https://upload.wikimedia.org/x/Portrait.jpg', 'https://commons.wikimedia.org/wiki/File:Portrait.jpg',
                 'public-domain', 'Popular Graphic Arts', ?, 800, 1000, 'image/jpeg', 1234, 'a', ?)`,
        subjectId,
        SOURCE,
        NOW.toISOString(),
      ))
    : null;
  return id(
    `INSERT INTO posts (item_id, vertical_id, image_id, hook, body, closer, alt_text, status, created_at)
     VALUES (?, ?, ?, 'A hook', 'A body', 'A closer', ?, 'draft', ?)`,
    itemId,
    verticalId,
    imageId,
    PLACEHOLDER,
    NOW.toISOString(),
  );
}

const run = (formats: readonly ('square' | 'pin')[], post = postId) =>
  composePost({ db, postId: post, formats, config: CONFIG, fontsDir: FONTS, mediaDir, now: () => NOW });

const POST: PostToCompose = {
  postId: 1,
  verticalId: 1,
  imageId: 1,
  status: 'draft',
  body: QUOTE,
  workTitle: 'Bleak House',
  workYear: 1853,
  author: 'Charles Dickens',
};
const IMAGE: PostImage = {
  imageId: 1,
  localPath: SOURCE,
  license: 'public-domain',
  attribution: 'Popular Graphic Arts',
  author: 'Charles Dickens',
  subjectSlug: 'charles-dickens',
};

beforeEach(async () => {
  db = testDb();
  seq = 0;
  mediaDir = mkdtempSync(join(tmpdir(), 'lantern-compose-'));
  mkdirSync(join(mediaDir, 'source'), { recursive: true });
  // A real, decodable portrait: sharp has to read and crop it, so opaque bytes will not do.
  await sharp({ create: { width: 800, height: 1000, channels: 3, background: '#6b6b6b' } })
    .jpeg()
    .toFile(join(mediaDir, SOURCE));
  postId = seed();
});

describe('composePost', () => {
  it('writes one card per format at the exact size the rendition matrix requires', async () => {
    const report = await run(['square', 'pin']);
    expect(report).toMatchObject({ postId, considered: 2, written: 2, failed: 0 });

    const rows = db
      .prepare('SELECT format, width, height, aspect, media_type AS mediaType, status, local_path AS localPath FROM renditions ORDER BY format')
      .all();
    expect(rows).toEqual([
      { format: 'pin', width: 1000, height: 1500, aspect: '2:3', mediaType: 'image', status: 'ready', localPath: renditionPath(postId, 'pin') },
      { format: 'square', width: 1200, height: 1200, aspect: '1:1', mediaType: 'image', status: 'ready', localPath: renditionPath(postId, 'square') },
    ]);

    for (const format of ['square', 'pin'] as const) {
      const file = join(mediaDir, renditionPath(postId, format));
      expect(existsSync(file)).toBe(true);
      const meta = await sharp(file).metadata();
      expect({ width: meta.width, height: meta.height, format: meta.format }).toEqual(
        format === 'square' ? { width: 1200, height: 1200, format: 'jpeg' } : { width: 1000, height: 1500, format: 'jpeg' },
      );
    }
  });

  it('replaces only the format it regenerates when it runs again', async () => {
    await run(['square', 'pin']);
    const before = db.prepare('SELECT id, format FROM renditions ORDER BY format').all() as { id: number; format: string }[];

    await run(['square']);
    const after = db.prepare('SELECT id, format FROM renditions ORDER BY format').all() as { id: number; format: string }[];

    expect(after.map((r) => r.format)).toEqual(['pin', 'square']);
    // The same rows, not duplicates: UNIQUE(post_id, format) is what makes a re-run safe.
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(db.prepare('SELECT COUNT(*) FROM renditions').pluck().get()).toBe(2);
  });

  it('rewrites the alt text to describe the card once one exists', async () => {
    expect(db.prepare('SELECT alt_text FROM posts WHERE id = ?').pluck().get(postId)).toBe(PLACEHOLDER);

    await run(['square']);

    const altText = db.prepare('SELECT alt_text FROM posts WHERE id = ?').pluck().get(postId) as string;
    expect(altText).toContain('Charles Dickens');
    expect(altText).toContain('A Tale of Two Cities, 1859');
    expect(altText).toContain(QUOTE);
  });

  it('fails the format rather than shrinking a quote that cannot be set legibly', async () => {
    const long = 'It was the best of times, it was the worst of times, it was the age of wisdom. '.repeat(8);
    const only = seed(long);
    const report = await run(['square'], only);

    expect(report).toMatchObject({ written: 0, failed: 1 });
    const outcome = report.items[0]?.outcome;
    expect(outcome?.status).toBe('failed');
    expect(outcome?.status === 'failed' && outcome.reason).toContain('cannot be set legibly');

    // No row and no file: a rendition's local_path must name a file that exists.
    expect(db.prepare('SELECT COUNT(*) FROM renditions WHERE post_id = ?').pluck().get(only)).toBe(0);
    expect(existsSync(join(mediaDir, renditionPath(only, 'square')))).toBe(false);
    // The alt text still describes no card, because there is none.
    expect(db.prepare('SELECT alt_text FROM posts WHERE id = ?').pluck().get(only)).toBe(PLACEHOLDER);
  });

  it('refuses a post that has no image yet', async () => {
    const imageless = seed(`${QUOTE} And this one has no portrait.`, false);
    await expect(run(['square'], imageless)).rejects.toThrow(ComposeError);
    await expect(run(['square'], imageless)).rejects.toThrow('run lantern media first');
  });

  it('refuses a post that does not exist', async () => {
    await expect(run(['square'], 9999)).rejects.toThrow('post 9999 does not exist');
  });
});

describe('alt text and the work line', () => {
  it('names the year only when the item records one', () => {
    expect(workLine(POST)).toBe('Bleak House, 1853');
    expect(workLine({ ...POST, workYear: null })).toBe('Bleak House');
  });

  it('describes the portrait as well as the quotation', () => {
    expect(composeAltText(POST, IMAGE)).toBe(`Quote card: a portrait of Charles Dickens behind the quotation from Bleak House, 1853: "${QUOTE}"`);
  });
});
```

- [ ] **Step 2: Run it to make sure it fails**

Run: `npx vitest run tests/compose/compose.test.ts`
Expected: FAIL, cannot resolve `../../src/compose/compose.js`.

- [ ] **Step 3: Write the stage**

Fonts load once per run so every format shares one outline cache. A failed format writes no row at all. Only `TextTooLongError` and `ComposeError` become a per-format failure; anything else aborts the run.

```ts
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import sharp from 'sharp';
import type { ComposeConfig } from '../config/schema.js';
import type { Db } from '../db/connection.js';
import type { PostImage } from '../db/images.js';
import { postImage } from '../db/images.js';
import type { PostToCompose } from '../db/posts.js';
import { postToCompose, updateAltText } from '../db/posts.js';
import { upsertRendition } from '../db/renditions.js';
import type { Logger } from '../lib/log.js';
import type { ImageFormat } from './formats.js';
import { IMAGE_FORMATS } from './formats.js';
import { cardLayout, TextTooLongError } from './template.js';
import type { Font } from './text.js';
import { loadFont } from './text.js';

/** A card this post cannot have: the run says why rather than writing a broken rendition. */
export class ComposeError extends Error {
  override name = 'ComposeError';
}

export interface ComposeOptions {
  db: Db;
  postId: number;
  formats: readonly ImageFormat[];
  config: ComposeConfig;
  /** Where the bundled fonts live, so a card never depends on a font the machine happens to have. */
  fontsDir: string;
  /** The media directory: originals are read from it, composed cards written under its renditions/ folder. */
  mediaDir: string;
  now?: () => Date;
  log?: Logger;
}

export type FormatOutcome =
  | {
      status: 'written';
      renditionId: number;
      localPath: string;
      bytes: number;
      /** The size the quote was set at: a card at the smallest size is one worth looking at. */
      quoteSize: number;
      lines: number;
    }
  | { status: 'failed'; reason: string };

export interface FormatReport {
  format: ImageFormat;
  outcome: FormatOutcome;
}

export interface ComposeReport {
  postId: number;
  considered: number;
  written: number;
  failed: number;
  items: FormatReport[];
}

/**
 * Composed cards live under the media directory by post and format, as the package layout in spec
 * section 4 lays out.
 *
 * Built with forward slashes rather than join(), because this is what the database stores: the
 * images table already holds posix-style paths, and a rendition's stored path becomes a public url
 * later (spec section 13). Only the absolute filesystem path is joined, and only at the point of use.
 */
export function renditionPath(postId: number, format: ImageFormat): string {
  return `renditions/${postId}/${format}.jpg`;
}

/** The work as the card prints it: the title, and the year when the item records one. */
export function workLine(post: PostToCompose): string {
  return post.workYear === null ? post.workTitle : `${post.workTitle}, ${post.workYear}`;
}

/**
 * What a reader who cannot see the card is told. Enrich's placeholder describes the quote alone;
 * once a portrait is behind it, the description says so (plan 2.6).
 */
export function composeAltText(post: PostToCompose, image: PostImage): string {
  return `Quote card: a portrait of ${image.author} behind the quotation from ${workLine(post)}: "${post.body}"`;
}

/** Renders one format and writes its rendition row. Throws TextTooLongError when the quote cannot be set legibly. */
async function renderFormat(
  options: ComposeOptions,
  post: PostToCompose,
  image: PostImage,
  fonts: { quote: Font; meta: Font },
  format: ImageFormat,
  now: Date,
): Promise<FormatOutcome> {
  const spec = IMAGE_FORMATS[format];
  const layout = cardLayout(spec, fonts, {
    quote: post.body,
    author: image.author,
    work: workLine(post),
    wordmark: options.config.wordmark,
  });

  const localPath = renditionPath(post.postId, format);
  const destPath = join(options.mediaDir, localPath);
  mkdirSync(dirname(destPath), { recursive: true });

  // The portrait is cropped from the top: a head is nearer the top of a plate than its centre.
  const base = await sharp(join(options.mediaDir, image.localPath))
    .resize(spec.width, spec.height, { fit: 'cover', position: 'top' })
    .toBuffer();
  const info = await sharp(base)
    .composite([{ input: Buffer.from(layout.svg), top: 0, left: 0 }])
    .jpeg({ quality: options.config.jpeg_quality })
    .toFile(destPath);

  // The rendition matrix is exact (spec section 11); a card of the wrong size is a failure, not a variation.
  if (info.width !== spec.width || info.height !== spec.height) {
    throw new ComposeError(`${format} rendered ${info.width}x${info.height}, but must be ${spec.width}x${spec.height}`);
  }

  const renditionId = upsertRendition(
    options.db,
    {
      postId: post.postId,
      format,
      mediaType: 'image',
      aspect: spec.aspect,
      width: info.width,
      height: info.height,
      localPath,
      bytes: info.size,
      status: 'ready',
      error: null,
    },
    now,
  );
  return { status: 'written', renditionId, localPath, bytes: info.size, quoteSize: layout.quoteSize, lines: layout.quoteLines.length };
}

/**
 * Composes a post's cards, one per requested format.
 *
 * Safe to re-run: regenerating a format replaces that format's rendition row and nothing else (spec
 * section 7). A format that cannot be set legibly fails on its own and leaves the others alone, and a
 * failed format writes no rendition row at all, because a row's local_path must name a file that
 * exists. Anything unexpected aborts the run rather than being recorded as a tidy failure.
 */
export async function composePost(options: ComposeOptions): Promise<ComposeReport> {
  const now = options.now ?? (() => new Date());
  const post = postToCompose(options.db, options.postId);
  if (post === undefined) throw new ComposeError(`post ${options.postId} does not exist`);
  const image = postImage(options.db, options.postId);
  if (image === undefined) throw new ComposeError(`post ${options.postId} has no image yet; run lantern media first`);

  // Loaded once per run, so every format shares one outline cache.
  const fonts = {
    quote: loadFont(join(options.fontsDir, options.config.quote_font)),
    meta: loadFont(join(options.fontsDir, options.config.meta_font)),
  };

  const report: ComposeReport = { postId: post.postId, considered: options.formats.length, written: 0, failed: 0, items: [] };
  for (const format of options.formats) {
    let outcome: FormatOutcome;
    try {
      outcome = await renderFormat(options, post, image, fonts, format, now());
    } catch (err) {
      if (!(err instanceof TextTooLongError) && !(err instanceof ComposeError)) throw err;
      outcome = { status: 'failed', reason: `${format}: ${err.message}` };
    }
    if (outcome.status === 'written') report.written++;
    else report.failed++;
    report.items.push({ format, outcome });
    options.log?.info('compose format', { postId: post.postId, format, outcome });
  }

  // The alt text describes the card, so it is only rewritten once a card exists.
  if (report.written > 0) updateAltText(options.db, post.postId, composeAltText(post, image));
  return report;
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/compose/compose.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add src/compose/compose.ts tests/compose/compose.test.ts
git commit -m "feat(compose): compose a post's cards and rewrite its alt text

Safe to re-run: a format replaces its own rendition row and nothing else. A
quote that cannot be set legibly fails that format and writes no row, because a
rendition's local_path must name a file that exists.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
```

---

### Task 5: The `lantern compose` command and the documentation

**Files:**
- Modify: `src/cli.ts`, `tests/cli.test.ts`, `claude.md`, `plan.md`

**Interfaces:**
- Consumes: everything Tasks 1-4 produce.

- [ ] **Step 1: Add the command**

Two patterns are new to this file: a `--post <id>` selector and a comma-separated `--formats` list. Everything judgeable from the arguments alone is judged before the database is opened, so a typo does not need a migrated database and an existing post before it is reported as a typo. The vertical comes from the post row, since compose selects a post rather than a vertical.

```ts
#!/usr/bin/env node
import Anthropic from '@anthropic-ai/sdk';
import { Command, CommanderError } from 'commander';
import { config as loadDotenv } from 'dotenv';
import { join, resolve } from 'node:path';
import { composePost, type FormatReport } from './compose/compose.js';
import { IMAGE_FORMAT_NAMES, isImageFormat, type ImageFormat } from './compose/formats.js';
import { loadConfig } from './config/load.js';
import { openDb, type Db } from './db/connection.js';
import { migrate, pendingMigrations } from './db/migrate.js';
import { MAX_ENRICH_FAILURES, postToCompose } from './db/posts.js';
import { syncConfig } from './db/sync.js';
import { runChecks } from './doctor/checks.js';
import { exitCode, formatReport } from './doctor/report.js';
import { anthropicChecker, anthropicWriter, loadEnrichPrompts } from './enrich/anthropic.js';
import { enrichVertical, type ItemReport } from './enrich/enrich.js';
import { DEFAULT_WIKI_ENDPOINTS } from './enrich/wikipedia.js';
import { anthropicPick, loadPickPrompt } from './harvest/anthropic-picker.js';
import { harvestVertical, type AuthorReport } from './harvest/harvest.js';
import { createHttpGet, DEFAULT_ENDPOINTS } from './harvest/sources.js';
import { redactUrl } from './lib/cache.js';
import { downloadWithRetry } from './lib/download.js';
import { buildUserAgent } from './lib/http.js';
import { createLogger } from './lib/log.js';
import { findProjectRoot, resolvePaths } from './lib/paths.js';
import { runStage } from './lib/run-stage.js';
import { DEFAULT_MEDIA_ENDPOINTS, MAX_IMAGE_BYTES } from './media/commons.js';
import { mediaVertical, type PostImageReport } from './media/media.js';
import { verifyVertical } from './verify/run.js';

const USER_AGENT_VERSION = '0.1';

const root = resolve(process.env.LANTERN_ROOT ?? findProjectRoot());
loadDotenv({ path: join(root, '.env'), quiet: true });
const paths = resolvePaths(process.env, root);
const log = createLogger({ dir: paths.logs });

const program = new Command()
  .name('lantern')
  .description('Automated educational social content engine')
  .exitOverride();

/** Opens the database for a pipeline stage, refusing one with pending migrations. */
function openMigratedDb(): Db {
  const db = openDb(paths.db);
  const pending = pendingMigrations(db, paths.migrations);
  if (pending.length > 0) throw new Error(`the database has pending migrations (${pending.join(', ')}); run lantern migrate`);
  return db;
}

function findVertical(db: Db, slug: string) {
  const vertical = loadConfig(paths.root).verticals.find((v) => v.slug === slug);
  if (vertical === undefined) throw new Error(`unknown vertical: ${slug}`);
  const verticalId = db.prepare('SELECT id FROM verticals WHERE slug = ?').pluck().get(slug) as number | undefined;
  if (verticalId === undefined) throw new Error(`vertical ${slug} is not in the database; run lantern migrate`);
  return { vertical, verticalId };
}

/** Cached GETs for a stage, with a log line for every retry so an unattended run can be read back. */
function cachedGet(refresh: boolean) {
  return createHttpGet({
    cacheDir: paths.cache,
    refresh,
    http: {
      userAgent: buildUserAgent(process.env.LANTERN_CONTACT, USER_AGENT_VERSION),
      // Gutendex can take more than a minute to answer a search; Wikidata and Wikipedia answer far sooner.
      timeoutMs: 180_000,
      onRetry: (event) => log.warn('http retry', { ...event, url: redactUrl(event.url) }),
    },
  });
}

function describeAuthor(author: AuthorReport): string {
  if (author.error !== null) return `${author.author}: skipped (${author.error})`;
  if (!author.loaded) return `${author.author}: not reached before the limit`;
  const count = (status: string) => author.books.filter((b) => b.outcome.status === status).length;
  const sum = (key: 'inserted' | 'conflicts' | 'conflictsWithDecided') =>
    author.books.reduce((n, b) => n + (b.outcome.status === 'harvested' ? b.outcome[key] : 0), 0);
  return `${author.author}: ${author.listedEntries} listed on Wikiquote; books harvested ${count('harvested')}, already picked ${count('already-picked')}, skipped ${count('skipped')}, failed ${count('failed')}; quotes inserted ${sum('inserted')}; attribution conflicts ${sum('conflicts')} recorded, ${sum('conflictsWithDecided')} with decided quotes`;
}

function describeItem(item: ItemReport): string {
  const head = `quote ${item.itemId} (${item.author}, ${item.workTitle})`;
  const outcome = item.outcome;
  if (outcome.status === 'failed') return `${head}: failed (${outcome.reason})`;
  const revised = outcome.rounds > 1 ? ', after one revision' : '';
  if (outcome.status === 'draft') return `${head}: post ${outcome.postId} drafted${revised}`;
  return `${head}: post ${outcome.postId} needs review${revised}: ${outcome.problems.join('; ')}`;
}

function describeImage(item: PostImageReport): string {
  const head = `post ${item.postId} (${item.author})`;
  const outcome = item.outcome;
  if (outcome.status === 'failed') return `${head}: failed (${outcome.reason})`;
  if (outcome.status === 'reused') return `${head}: image ${outcome.imageId} reused`;
  return `${head}: image ${outcome.imageId} from ${outcome.title} (${outcome.from}; ${outcome.refused.length} refused)`;
}

function describeCard(item: FormatReport): string {
  const outcome = item.outcome;
  if (outcome.status === 'failed') return `${item.format}: failed (${outcome.reason})`;
  const size = Math.round(outcome.bytes / 1024);
  return `${item.format}: rendition ${outcome.renditionId} at ${outcome.localPath} (${size} KB, quote ${outcome.quoteSize}px over ${outcome.lines} lines)`;
}

/** The vertical a post belongs to, since compose selects a post rather than a vertical. */
function findVerticalById(db: Db, verticalId: number) {
  const slug = db.prepare('SELECT slug FROM verticals WHERE id = ?').pluck().get(verticalId) as string | undefined;
  if (slug === undefined) throw new Error(`vertical ${verticalId} is not in the database; run lantern migrate`);
  return findVertical(db, slug);
}

program
  .command('migrate')
  .description('Apply pending migrations and sync config/ into the database')
  .action(async () => {
    const db = openDb(paths.db);
    const { applied } = migrate(db, paths.migrations);
    console.log(applied.length ? `applied: ${applied.join(', ')}` : 'migrations: up to date');
    const counts = await runStage(db, { stage: 'migrate' }, () => syncConfig(db, loadConfig(paths.root)));
    console.log(`verticals: ${JSON.stringify(counts.verticals)}`);
    console.log(`channels:  ${JSON.stringify(counts.channels)}`);
    log.info('migrate complete', { applied, counts });
  });

program
  .command('harvest')
  .description('Pull raw quotes from public-domain texts for a vertical; exits 1 if an author was skipped, a book failed, or a passage clashes with a decided quote')
  .requiredOption('--vertical <slug>', 'the vertical to harvest')
  .option('--limit <n>', 'start no new book once this many quotes have been inserted', '25')
  .option('--refresh', 'ignore cached responses and fetch again')
  .action(async (opts: { vertical: string; limit: string; refresh?: boolean }) => {
    const limit = Number(opts.limit);
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`--limit must be a positive integer, got ${opts.limit}`);
    const db = openMigratedDb();
    const { vertical, verticalId } = findVertical(db, opts.vertical);
    const harvest = vertical.harvest;
    if (harvest === undefined) throw new Error(`vertical ${vertical.slug} has no harvest section`);
    if (!process.env.ANTHROPIC_API_KEY?.trim()) throw new Error('ANTHROPIC_API_KEY is not set; the passage picker needs it');

    const get = cachedGet(opts.refresh === true);
    // A pick only reads, so retrying it is safe; the timeout keeps one stuck batch from stalling a cron run.
    const client = new Anthropic({ timeout: 120_000, maxRetries: 3 });
    const report = await runStage(db, { stage: 'harvest', verticalId }, () =>
      harvestVertical({
        db,
        verticalId,
        harvest,
        get,
        endpoints: DEFAULT_ENDPOINTS,
        pick: anthropicPick(client, harvest.picker.model),
        prompt: loadPickPrompt(paths.root),
        limit,
        log,
      }),
    );
    for (const author of report.authors) console.log(describeAuthor(author));
    console.log(`inserted: ${report.inserted}`);
    const trouble = report.authors.some(
      (a) =>
        a.error !== null ||
        a.books.some((b) => b.outcome.status === 'failed' || (b.outcome.status === 'harvested' && b.outcome.conflictsWithDecided > 0)),
    );
    if (trouble) process.exitCode = 1;
  });

program
  .command('verify')
  .description('Decide raw quotes for a vertical with the attribution gates; exits 1 if a quote has malformed evidence')
  .requiredOption('--vertical <slug>', 'the vertical to verify')
  .option('--retry-insufficient', 'first reopen quotes rejected only for insufficient evidence')
  .action(async (opts: { vertical: string; retryInsufficient?: boolean }) => {
    const db = openMigratedDb();
    const { verticalId } = findVertical(db, opts.vertical);
    const report = await runStage(db, { stage: 'verify', verticalId }, () =>
      verifyVertical(db, verticalId, { retryInsufficient: opts.retryInsufficient === true, log }),
    );
    if (report.reopened > 0) console.log(`reopened: ${report.reopened}`);
    console.log(`verified: ${report.verified}`);
    console.log(`rejected: ${JSON.stringify(report.rejected)}`);
    console.log(`left raw: ${report.unchecked} without a Wikiquote check, ${report.malformed} with malformed evidence`);
    if (report.malformed > 0) process.exitCode = 1;
  });

program
  .command('enrich')
  .description('Write posts for verified quotes from Wikipedia paragraphs, fact-check every sentence and allow one revision; exits 1 if a quote could not be written')
  .requiredOption('--vertical <slug>', 'the vertical to enrich')
  .option('--limit <n>', 'write posts for at most this many verified quotes', '5')
  .option('--refresh', 'ignore cached Wikidata and Wikipedia responses and fetch again')
  .option('--retry-failed', `also try quotes that have already failed ${MAX_ENRICH_FAILURES} times`)
  .action(async (opts: { vertical: string; limit: string; refresh?: boolean; retryFailed?: boolean }) => {
    const limit = Number(opts.limit);
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`--limit must be a positive integer, got ${opts.limit}`);
    const db = openMigratedDb();
    const { vertical, verticalId } = findVertical(db, opts.vertical);
    const enrich = vertical.enrich;
    if (enrich === undefined) throw new Error(`vertical ${vertical.slug} has no enrich section`);
    if (!process.env.ANTHROPIC_API_KEY?.trim()) throw new Error('ANTHROPIC_API_KEY is not set; the writer and the fact check need it');
    const prompts = loadEnrichPrompts(paths.root, vertical.slug);

    // A writer call can think for minutes before it answers (the SDK estimates up to 450 s for 16000 tokens).
    // A call only reads, so retrying it is safe.
    const client = new Anthropic({ timeout: 600_000, maxRetries: 2 });
    const report = await runStage(db, { stage: 'enrich', verticalId }, () =>
      enrichVertical({
        db,
        verticalId,
        vertical,
        enrich,
        get: cachedGet(opts.refresh === true),
        endpoints: DEFAULT_WIKI_ENDPOINTS,
        write: anthropicWriter(client, enrich.writer_model),
        check: anthropicChecker(client, enrich.checker_model),
        prompts,
        limit,
        retryFailed: opts.retryFailed === true,
        log,
      }),
    );
    for (const item of report.items) console.log(describeItem(item));
    console.log(`posts: ${report.drafted} draft, ${report.needsReview} needs review; failed: ${report.failed}`);
    if (report.givenUp > 0) {
      console.log(`given up after ${MAX_ENRICH_FAILURES} failed attempts: ${report.givenUp} (run with --retry-failed to try them again)`);
    }
    if (report.failed > 0) process.exitCode = 1;
  });

program
  .command('media')
  .description('Give each post a public-domain source image from Wikimedia Commons; exits 1 if a post could not be given one')
  .requiredOption('--vertical <slug>', 'the vertical to give images')
  .option('--limit <n>', 'give an image to at most this many posts', '25')
  .option('--refresh', 'ignore cached Wikidata and Commons responses and fetch again')
  .action(async (opts: { vertical: string; limit: string; refresh?: boolean }) => {
    const limit = Number(opts.limit);
    if (!Number.isInteger(limit) || limit < 1) throw new Error(`--limit must be a positive integer, got ${opts.limit}`);
    const db = openMigratedDb();
    const { verticalId } = findVertical(db, opts.vertical);
    const userAgent = buildUserAgent(process.env.LANTERN_CONTACT, USER_AGENT_VERSION);
    const report = await runStage(db, { stage: 'media', verticalId }, () =>
      mediaVertical({
        db,
        verticalId,
        get: cachedGet(opts.refresh === true),
        endpoints: DEFAULT_MEDIA_ENDPOINTS,
        // Originals are streamed under data/media/source/, never into the response cache.
        download: async (url, destPath) =>
          downloadWithRetry(url, destPath, {
            userAgent,
            maxBytes: MAX_IMAGE_BYTES,
            onRetry: (event) => log.warn('download retry', { ...event, url: redactUrl(event.url) }),
          }),
        mediaDir: paths.media,
        limit,
        log,
      }),
    );
    for (const item of report.items) console.log(describeImage(item));
    console.log(`images: ${report.attached} downloaded, ${report.reused} reused; failed: ${report.failed}`);
    if (report.noWikidataId > 0) console.log(`waiting on a subject Wikidata id: ${report.noWikidataId}`);
    if (report.failed > 0) process.exitCode = 1;
  });

program
  .command('compose')
  .description('Render the cards for a post from its source image and its text; exits 1 if a format could not be rendered')
  .requiredOption('--post <id>', 'the post to compose')
  .option('--formats <list>', `comma-separated formats to render (${IMAGE_FORMAT_NAMES.join(', ')}); defaults to the vertical's compose.formats`)
  .action(async (opts: { post: string; formats?: string }) => {
    // Everything that can be judged from the arguments alone is judged first: a typo should not need
    // a migrated database and an existing post before it is reported as a typo.
    const postId = Number(opts.post);
    if (!Number.isInteger(postId) || postId < 1) throw new Error(`--post must be a positive integer, got ${opts.post}`);
    const named = opts.formats?.split(',').map((format) => format.trim()).filter((format) => format !== '');
    if (named !== undefined && named.length === 0) throw new Error('--formats must name at least one format');
    for (const format of named ?? []) {
      if (!isImageFormat(format)) throw new Error(`unknown format: ${format}; expected ${IMAGE_FORMAT_NAMES.join(', ')}`);
    }

    const db = openMigratedDb();
    const post = postToCompose(db, postId);
    if (post === undefined) throw new Error(`post ${postId} does not exist`);
    const { vertical, verticalId } = findVerticalById(db, post.verticalId);
    const compose = vertical.compose;
    if (compose === undefined) throw new Error(`vertical ${vertical.slug} has no compose section`);
    const formats: readonly ImageFormat[] = named === undefined ? compose.formats : (named as ImageFormat[]);

    const report = await runStage(db, { stage: 'compose', verticalId }, () =>
      composePost({
        db,
        postId,
        formats,
        config: compose,
        fontsDir: join(paths.root, 'assets', 'fonts'),
        mediaDir: paths.media,
        log,
      }),
    );
    for (const item of report.items) console.log(describeCard(item));
    console.log(`post ${report.postId}: ${report.written} rendered, ${report.failed} failed`);
    if (report.failed > 0) process.exitCode = 1;
  });

program
  .command('doctor')
  .description('Report system health; exits 1 if any check fails')
  .option('--json', 'emit JSON instead of a table')
  .action((opts: { json?: boolean }) => {
    const db = openDb(paths.db);
    const results = runChecks({
      db,
      root: paths.root,
      migrationsDir: paths.migrations,
      env: process.env,
      now: new Date(),
    });
    console.log(opts.json ? JSON.stringify(results, null, 2) : formatReport(results));
    log.info('doctor complete', { results });
    process.exitCode = exitCode(results);
  });

program.parseAsync().catch((err: unknown) => {
  if (err instanceof CommanderError) {
    // Commander has already printed its message (unknown command, bad option, help) to the terminal.
    if (err.exitCode !== 0) log.error('command rejected', { code: err.code, message: err.message });
    process.exitCode = err.exitCode;
    return;
  }
  log.error('command failed', { err });
  console.error(err instanceof Error ? err.message : err);
  process.exitCode = 1;
});
```

- [ ] **Step 2: Add the command's tests**

```ts
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// Resolved as an absolute file:// URL (not the bare "tsx" specifier) so the loader
// resolves from this repo's node_modules regardless of the child process's cwd.
const TSX_LOADER = pathToFileURL(join(ROOT, 'node_modules', 'tsx', 'dist', 'loader.mjs')).href;

interface LanternOpts {
  cwd?: string;
  root?: string | null; // null omits LANTERN_ROOT from the child env
  db?: string | null; // null omits LANTERN_DB from the child env
  logs?: string | null; // null omits LANTERN_LOGS from the child env
  env?: Record<string, string>; // extra child env, applied last
}

function lantern(args: string[], scratch: string, opts: LanternOpts = {}) {
  const env: Record<string, string | undefined> = {
    ...process.env,
    FB_PAGE_ID_COMMONPLACE: 'x',
    PINTEREST_BOARD_ID_COMMONPLACE: 'x',
    YT_CHANNEL_ID_LOOK_CLOSER: 'x',
    LANTERN_CONTACT: 'test@example.invalid',
  };

  const root = 'root' in opts ? opts.root : ROOT;
  if (root === null) delete env.LANTERN_ROOT;
  else env.LANTERN_ROOT = root;

  const db = 'db' in opts ? opts.db : join(scratch, 'lantern.db');
  if (db === null) delete env.LANTERN_DB;
  else env.LANTERN_DB = db;

  const logs = 'logs' in opts ? opts.logs : join(scratch, 'logs');
  if (logs === null) delete env.LANTERN_LOGS;
  else env.LANTERN_LOGS = logs;

  Object.assign(env, opts.env ?? {});

  const res = spawnSync(process.execPath, ['--import', TSX_LOADER, join(ROOT, 'src', 'cli.ts'), ...args], {
    cwd: opts.cwd ?? ROOT,
    encoding: 'utf8',
    env,
  });
  return { code: res.status, out: res.stdout + res.stderr };
}

function logRecords(logs: string): Record<string, unknown>[] {
  if (!existsSync(logs)) return [];
  return readdirSync(logs).flatMap((file) =>
    readFileSync(join(logs, file), 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>),
  );
}

describe('lantern CLI', () => {
  it('doctor fails on a fresh database, then passes after migrate', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));

    const before = lantern(['doctor'], scratch);
    expect(before.code).toBe(1);
    expect(before.out).toContain('[FAIL] db.migrations');

    const migrated = lantern(['migrate'], scratch);
    expect(migrated.code).toBe(0);
    expect(migrated.out).toContain('001_initial.sql');

    const after = lantern(['doctor'], scratch);
    expect(after.code).toBe(0);
    expect(after.out).toContain('0 failed, 0 warnings');
  }, 30_000);

  it('doctor --json emits machine-readable results', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
    lantern(['migrate'], scratch);
    const res = lantern(['doctor', '--json'], scratch);
    const parsed = JSON.parse(res.out) as Array<{ name: string; status: string }>;
    expect(parsed.find((r) => r.name === 'db.integrity')?.status).toBe('ok');
  }, 30_000);

  it('resolves the project root from its own install location, not an unrelated cwd', () => {
    const emptyCwd = mkdtempSync(join(tmpdir(), 'lantern-cli-cwd-'));
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-scratch-'));

    const migrated = lantern(['migrate'], scratch, { cwd: emptyCwd, root: null });
    expect(migrated.code).toBe(0);
    expect(migrated.out).toContain('001_initial.sql');

    const doctored = lantern(['doctor'], scratch, { cwd: emptyCwd, root: null });
    expect(doctored.code).toBe(0);

    expect(existsSync(join(emptyCwd, 'data'))).toBe(false);
    expect(existsSync(join(emptyCwd, 'logs'))).toBe(false);
  }, 30_000);

  it('honours LANTERN_DB / LANTERN_LOGS set in .env at the project root', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-env-'));
    cpSync(join(ROOT, 'config'), join(scratch, 'config'), { recursive: true });
    cpSync(join(ROOT, 'migrations'), join(scratch, 'migrations'), { recursive: true });
    writeFileSync(
      join(scratch, '.env'),
      [
        'LANTERN_DB=custom/fromdotenv.db',
        'LANTERN_LOGS=dotenvlogs',
        'FB_PAGE_ID_COMMONPLACE=x',
        'PINTEREST_BOARD_ID_COMMONPLACE=x',
        'YT_CHANNEL_ID_LOOK_CLOSER=x',
        '',
      ].join('\n'),
    );

    const migrated = lantern(['migrate'], scratch, { root: scratch, db: null, logs: null });
    expect(migrated.code).toBe(0);

    expect(existsSync(join(scratch, 'custom', 'fromdotenv.db'))).toBe(true);
    expect(existsSync(join(scratch, 'dotenvlogs'))).toBe(true);
  }, 30_000);

  it('logs a mistyped command to logs/ and exits 1', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
    const res = lantern(['doctr'], scratch);
    expect(res.code).toBe(1);
    expect(res.out).toContain("unknown command 'doctr'");
    expect(logRecords(join(scratch, 'logs'))).toEqual([
      expect.objectContaining({ level: 'error', msg: 'command rejected', code: 'commander.unknownCommand' }),
    ]);
  }, 30_000);

  it('exits 0 for --help without logging an error', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
    const res = lantern(['--help'], scratch);
    expect(res.code).toBe(0);
    expect(res.out).toContain('Usage: lantern');
    expect(logRecords(join(scratch, 'logs')).filter((r) => r.level === 'error')).toEqual([]);
  }, 30_000);

  it('harvest refuses a database with pending migrations before anything else', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
    const res = lantern(['harvest', '--vertical', 'literature'], scratch, { env: { ANTHROPIC_API_KEY: '' } });
    expect(res.code).toBe(1);
    expect(res.out).toContain('run lantern migrate');
  }, 30_000);

  it('harvest refuses a vertical without a harvest section, and a missing API key, without fetching anything', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
    expect(lantern(['migrate'], scratch).code).toBe(0);
    const science = lantern(['harvest', '--vertical', 'science-curious'], scratch, { env: { ANTHROPIC_API_KEY: '' } });
    expect(science.code).toBe(1);
    expect(science.out).toContain('vertical science-curious has no harvest section');
    const cache = join(scratch, 'cache');
    const noKey = lantern(['harvest', '--vertical', 'literature'], scratch, { env: { ANTHROPIC_API_KEY: '', LANTERN_CACHE: cache } });
    expect(noKey.code).toBe(1);
    expect(noKey.out).toContain('ANTHROPIC_API_KEY is not set');
    expect(existsSync(cache)).toBe(false);
  }, 30_000);

  it('harvest and verify refuse an unknown vertical', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
    expect(lantern(['migrate'], scratch).code).toBe(0);
    for (const command of ['harvest', 'verify']) {
      const res = lantern([command, '--vertical', 'poetry'], scratch, { env: { ANTHROPIC_API_KEY: '' } });
      expect(res.code).toBe(1);
      expect(res.out).toContain('unknown vertical: poetry');
    }
  }, 30_000);

  it('verify decides nothing on an empty database and records the stage', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
    expect(lantern(['migrate'], scratch).code).toBe(0);
    const res = lantern(['verify', '--vertical', 'literature'], scratch);
    expect(res.code).toBe(0);
    expect(res.out).toContain('verified: 0');
    expect(res.out).toContain('left raw: 0 without a Wikiquote check, 0 with malformed evidence');
  }, 30_000);

  it('enrich refuses a bad limit, pending migrations, a vertical without an enrich section, and a missing API key, without fetching anything', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
    const badLimit = lantern(['enrich', '--vertical', 'literature', '--limit', '0'], scratch, { env: { ANTHROPIC_API_KEY: '' } });
    expect(badLimit.code).toBe(1);
    expect(badLimit.out).toContain('--limit must be a positive integer, got 0');
    const pending = lantern(['enrich', '--vertical', 'literature'], scratch, { env: { ANTHROPIC_API_KEY: '' } });
    expect(pending.code).toBe(1);
    expect(pending.out).toContain('run lantern migrate');
    expect(lantern(['migrate'], scratch).code).toBe(0);
    const science = lantern(['enrich', '--vertical', 'science-curious'], scratch, { env: { ANTHROPIC_API_KEY: '' } });
    expect(science.code).toBe(1);
    expect(science.out).toContain('vertical science-curious has no enrich section');
    const cache = join(scratch, 'cache');
    const noKey = lantern(['enrich', '--vertical', 'literature'], scratch, { env: { ANTHROPIC_API_KEY: '', LANTERN_CACHE: cache } });
    expect(noKey.code).toBe(1);
    expect(noKey.out).toContain('ANTHROPIC_API_KEY is not set');
    expect(existsSync(cache)).toBe(false);
  }, 60_000);

  it('enrich writes nothing when no verified quote is waiting for a post', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
    expect(lantern(['migrate'], scratch).code).toBe(0);
    const cache = join(scratch, 'cache');
    const res = lantern(['enrich', '--vertical', 'literature'], scratch, { env: { ANTHROPIC_API_KEY: 'test-key-never-sent', LANTERN_CACHE: cache } });
    expect(res.code).toBe(0);
    expect(res.out).toContain('posts: 0 draft, 0 needs review; failed: 0');
    expect(existsSync(cache)).toBe(false);
  }, 30_000);

  it('media refuses a bad limit, pending migrations and an unknown vertical, and writes nothing when no post needs an image', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
    const badLimit = lantern(['media', '--vertical', 'literature', '--limit', '0'], scratch);
    expect(badLimit.code).toBe(1);
    expect(badLimit.out).toContain('--limit must be a positive integer, got 0');

    const pending = lantern(['media', '--vertical', 'literature'], scratch);
    expect(pending.code).toBe(1);
    expect(pending.out).toContain('run lantern migrate');

    expect(lantern(['migrate'], scratch).code).toBe(0);
    const unknown = lantern(['media', '--vertical', 'poetry'], scratch);
    expect(unknown.code).toBe(1);
    expect(unknown.out).toContain('unknown vertical: poetry');

    const media = join(scratch, 'media');
    const res = lantern(['media', '--vertical', 'literature'], scratch, { env: { LANTERN_MEDIA: media, LANTERN_CACHE: join(scratch, 'cache') } });
    expect(res.code).toBe(0);
    expect(res.out).toContain('images: 0 downloaded, 0 reused; failed: 0');
    expect(existsSync(media)).toBe(false);
  }, 60_000);

  it('compose refuses a bad post id, an unknown format, pending migrations and a post that does not exist', () => {
    const scratch = mkdtempSync(join(tmpdir(), 'lantern-cli-'));
    const badPost = lantern(['compose', '--post', '0'], scratch);
    expect(badPost.code).toBe(1);
    expect(badPost.out).toContain('--post must be a positive integer, got 0');

    const notANumber = lantern(['compose', '--post', 'seven'], scratch);
    expect(notANumber.code).toBe(1);
    expect(notANumber.out).toContain('--post must be a positive integer, got seven');

    const pending = lantern(['compose', '--post', '1'], scratch);
    expect(pending.code).toBe(1);
    expect(pending.out).toContain('run lantern migrate');

    expect(lantern(['migrate'], scratch).code).toBe(0);

    // The format list is checked before any post is read, so a typo costs nothing.
    const unknownFormat = lantern(['compose', '--post', '1', '--formats', 'square,poster'], scratch);
    expect(unknownFormat.code).toBe(1);
    expect(unknownFormat.out).toContain('unknown format: poster; expected square, pin');

    const empty = lantern(['compose', '--post', '1', '--formats', ' , '], scratch);
    expect(empty.code).toBe(1);
    expect(empty.out).toContain('--formats must name at least one format');

    const missing = lantern(['compose', '--post', '1'], scratch, { env: { LANTERN_MEDIA: join(scratch, 'media') } });
    expect(missing.code).toBe(1);
    expect(missing.out).toContain('post 1 does not exist');
  }, 60_000);
});
```

- [ ] **Step 3: `claude.md`, the compose stage description**

Replace exactly:

```
**`lantern compose --post 123 --formats square,pin`**
Render image renditions with Sharp from the post's source image + text. One
`renditions` row per format. Safe to re-run; regenerating a format replaces that
row only.
```

with:

```
**`lantern compose --post 123 --formats square,pin`**
Render image renditions with Sharp from the post's source image + text. One
`renditions` row per format. Safe to re-run; regenerating a format replaces that
row only, and `--formats` defaults to the vertical's `compose.formats`. Every
character is drawn as a glyph outline from a font bundled in `assets/fonts/`, so
a card never depends on what the machine has installed. A quote that cannot be
set legibly at the smallest size fails that format and writes no `renditions`
row at all, rather than shrinking to something unreadable; the other formats
still render. The stage then rewrites `posts.alt_text`, because once a card
exists the card is what a reader sees.
```

- [ ] **Step 4: `claude.md`, the composition paragraph in section 10**

Replace exactly:

```
**Composition** (Sharp): one template per (vertical, format) so the feed reads as
one brand — same margin system, same two typefaces, same wordmark placement,
adapted per aspect rather than naively letterboxed. Text must stay legible at
phone thumbnail size: large type, high contrast, a scrim over busy photographs.
Build the templates once, check them on an actual phone, then stop fiddling.
```

with:

```
**Composition** (Sharp): one template per (vertical, format) so the feed reads as
one brand — same margin system, same two typefaces, same wordmark placement,
adapted per aspect rather than naively letterboxed. Text must stay legible at
phone thumbnail size: large type, high contrast, a scrim over busy photographs.
Build the templates once, check them on an actual phone, then stop fiddling.

Text is drawn as glyph outlines with opentype.js, never as an SVG `<text>`
element. Two rules were paid for in corrupted cards and are not optional: emit
each glyph once in font units with **every contour explicitly closed** (the
library emits no closing command, and the rasteriser mis-fills the open subpaths
at card scale, filling counters solid and dropping letters), and place it with a
`transform` rather than baking the position into every coordinate. Cache the
outlines **per font object**, never by font name: glyph indices mean different
letters in different fonts, so a shared cache silently draws one font's letters
for the other's.
```

- [ ] **Step 5: `plan.md`, milestone 2.6**

Replace exactly:

```
**2.6 Composition** — `src/compose/`, one template per (vertical, format)
- Sharp + SVG text overlay for `square` (1200×1200) and `pin` (1000×1500). Shared margin system, two typefaces (bundle OFL-licensed fonts and record their licenses), consistent wordmark, scrim over busy images.
- Tests: exact output dimensions, text never overflows its box (measure before render and fail the rendition rather than shrink to illegibility), and the `renditions` row is replaced per format on re-run.
- The composed card is what a reader sees, so this stage owns `posts.alt_text`: rewrite it from the quote, the author and the chosen image (2.5 leaves the enrich text in place).
- Check the output on a real phone, then stop fiddling (spec §10).
```

with:

```
**2.6 Composition** — `src/compose/`, one template per (vertical, format)
- Sharp + SVG text overlay for `square` (1200×1200) and `pin` (1000×1500), written as JPEG at `compose.jpeg_quality` (90). No migration: `renditions` and its `(post_id, status)` index have both existed since `001_initial.sql`.
- Typefaces: **Lora** for the quotation, **Work Sans** for the author, the work and the wordmark (open decision #9, decided 2026-09-15). Both are variable OFL fonts committed under `assets/fonts/` with their `OFL.txt`, each well under the 500 KB blob limit. The wordmark text (`THE COMMONPLACE BOOK`) lives in `compose.wordmark` in the vertical config, so the still-open page name (#1) can change without touching code.
- Text is laid out glyph by glyph with opentype.js, because its string APIs run feature substitution and throw on these fonts. Emit each outline **in font units with every contour closed** and place it with a `transform`: absolute coordinates plus the library's unclosed contours make the rasteriser drop and mis-fill letters at card scale. Cache outlines **per font object**, never by font name — glyph indices differ between fonts, and a shared cache renders one font's letters for the other's (it printed "Priwe anw Prejuwice" for "Pride and Prejudice").
- Tests: exact output dimensions, a quote that cannot be set at the smallest size fails that format and writes no row, re-running replaces one format's row and leaves the others, and the same letter yields different path data in the two fonts.
- The composed card is what a reader sees, so this stage owns `posts.alt_text`: rewrite it from the quote, the author and the chosen image (2.5 leaves the enrich text in place).
- Check the output on a real phone, then stop fiddling (spec §10).
```

- [ ] **Step 6: `plan.md`, open decision 9**

Replace exactly:

```
| 9 | The two typefaces and wordmark | Phase 2.6 | Must be OFL or otherwise redistributable |
```

with:

```
| 9 | The two typefaces and wordmark | Phase 2.6 | **Decided 2026-09-15:** Lora sets the quotation, Work Sans the author line and wordmark; both OFL, committed with their licences. Wordmark text `THE COMMONPLACE BOOK` lives in `compose.wordmark`, not in code, so open decision #1 can still change it |
```

- [ ] **Step 7: Run the full suite**

Run: `npx tsc --noEmit && npx vitest run`
Expected: clean, 44 files and 599 tests pass (up from 42 and 580).

- [ ] **Step 8: Commit**

```bash
git add src/cli.ts tests/cli.test.ts claude.md plan.md
git commit -m "feat(compose): add the lantern compose command and document the stage

Records the two rendering rules in the spec, because both were paid for in
corrupted cards: closed contours placed by transform, and an outline cache keyed
per font object. Closes open decision 9 with Lora and Work Sans.

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
```

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

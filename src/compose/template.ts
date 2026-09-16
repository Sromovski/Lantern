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

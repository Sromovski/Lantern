import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IMAGE_FORMATS } from '../../src/compose/formats.js';
import { cardLayout, TextTooLongError } from '../../src/compose/template.js';
import { loadFont } from '../../src/compose/text.js';

const FONTS = fileURLToPath(new URL('../../assets/fonts/', import.meta.url));
const fonts = { quote: loadFont(`${FONTS}Lora.ttf`), meta: loadFont(`${FONTS}WorkSans.ttf`) };
const TEXT = {
  quote: 'Truth is stranger than fiction.',
  author: 'Mark Twain',
  work: 'Following the Equator, 1897',
  wordmark: 'THE COMMONPLACE BOOK',
};

describe('cardLayout', () => {
  it('draws the scrim, the quotation, the credit and the wordmark inside the card', () => {
    const { width, height } = IMAGE_FORMATS.square;
    const layout = cardLayout(IMAGE_FORMATS.square, fonts, TEXT);

    expect(layout.svg).toContain(`width="${width}" height="${height}"`);
    // Two scrims: one over the whole card, a stronger band at the foot.
    expect((layout.svg.match(/<rect /g) ?? []).length).toBe(2);
    // One path per non-space glyph, across the quotation, the author, the work and the wordmark.
    expect((layout.svg.match(/<path /g) ?? []).length).toBeGreaterThan(60);
    expect(layout.quoteSize).toBeGreaterThanOrEqual(40);
    expect(layout.quoteLines.join(' ')).toContain('Truth is stranger than fiction.');

    // Nothing is placed outside the card.
    for (const match of layout.svg.matchAll(/translate\((-?[\d.]+) (-?[\d.]+)\)/g)) {
      expect(Number(match[1])).toBeGreaterThanOrEqual(0);
      expect(Number(match[1])).toBeLessThanOrEqual(width);
      expect(Number(match[2])).toBeGreaterThan(0);
      expect(Number(match[2])).toBeLessThanOrEqual(height);
    }
  });

  it('refuses a quote that cannot be set legibly rather than shrinking it', () => {
    const long = 'It was the best of times, it was the worst of times, it was the age of wisdom. '.repeat(8);
    expect(() => cardLayout(IMAGE_FORMATS.square, fonts, { ...TEXT, quote: long })).toThrow(TextTooLongError);
  });
});

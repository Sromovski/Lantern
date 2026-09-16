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

import { createHash } from 'node:crypto';

const APOSTROPHES = new Set(["'", '\u2018', '\u2019', '\u201B', '\u02BC', '`']);
const WORD_CHAR = /[\p{L}\p{N}\p{M}]/u;
const FORMAT_CHAR = /\p{Cf}/u;

export interface NormalizedText {
  source: string;
  text: string;
  map: Uint32Array;
}

export type PreparedHaystack = NormalizedText;

class OffsetMap {
  private buf: Uint32Array;
  length = 0;

  constructor(capacity: number) {
    this.buf = new Uint32Array(Math.max(16, capacity));
  }

  push(offset: number): void {
    if (this.length === this.buf.length) {
      const grown = new Uint32Array(this.buf.length * 2);
      grown.set(this.buf);
      this.buf = grown;
    }
    this.buf[this.length++] = offset;
  }

  finish(): Uint32Array {
    return this.buf.slice(0, this.length);
  }
}

export function normalizeWithMap(input: string): NormalizedText {
  const source = input.normalize('NFC');
  let text = '';
  const map = new OffsetMap(source.length);
  let pendingSpace = false;

  for (let i = 0; i < source.length; ) {
    const ch = String.fromCodePoint(source.codePointAt(i)!);
    if (!APOSTROPHES.has(ch) && !FORMAT_CHAR.test(ch)) {
      for (const out of ch.normalize('NFKC').toLowerCase()) {
        if (!WORD_CHAR.test(out)) {
          pendingSpace = true;
          continue;
        }
        if (pendingSpace && text.length > 0) {
          text += ' ';
          map.push(i);
        }
        pendingSpace = false;
        text += out;
        for (let k = 0; k < out.length; k++) map.push(i);
      }
    }
    i += ch.length;
  }
  return { source, text, map: map.finish() };
}

export function normalizeText(input: string): string {
  return normalizeWithMap(input).text;
}

export function bodyHash(input: string): string {
  return createHash('sha256').update(normalizeText(input)).digest('hex');
}

export interface Located {
  start: number;
  end: number;
  excerpt: string;
}

export function prepareHaystack(fullText: string): PreparedHaystack {
  return normalizeWithMap(fullText);
}

export function locateQuoteIn(quote: string, hay: PreparedHaystack): Located | null {
  const needle = normalizeText(quote);
  if (needle.length === 0) return null;

  for (let from = 0; ; ) {
    const at = hay.text.indexOf(needle, from);
    if (at === -1) return null;
    const after = at + needle.length;
    const wholeWord =
      (at === 0 || hay.text[at - 1] === ' ') && (after === hay.text.length || hay.text[after] === ' ');
    if (wholeWord) {
      const start = hay.map[at]!;
      const last = hay.map[after - 1]!;
      const end = last + String.fromCodePoint(hay.source.codePointAt(last)!).length;
      return { start, end, excerpt: hay.source.slice(start, end) };
    }
    from = at + 1;
  }
}

export function locateQuote(quote: string, fullText: string): Located | null {
  return locateQuoteIn(quote, prepareHaystack(fullText));
}

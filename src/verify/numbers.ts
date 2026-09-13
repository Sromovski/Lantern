const NUMBER_CORE = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|(?<!\d)\.\d+`;

/**
 * A numeral together with the context that changes its meaning: a minus sign (ASCII, U+2212,
 * U+2012, U+2013, U+FE63 or U+FF0D, only when no letter or digit precedes it), an attached scale
 * abbreviation (bn/tn/mn/mln/bln/k/m/b, kept exactly as written and never multiplied or expanded
 * to a scale word, because e.g. "m" may mean meters), a decade suffix (an apostrophe, ASCII or
 * U+2019, may precede the "s"), a superscript exponent, a percent, and a scale word. A hyphen,
 * with optional spaces around it, is also accepted before a scale word. Scale words are kept as
 * words, never multiplied out: "93 million" does not match "93,000,000" (strict, fail closed).
 */
const NUMERAL = new RegExp(
  String.raw`(?<sign>(?<![\p{L}\p{N}])[-\u2212\u2012\u2013\uFE63\uFF0D])?` +
    `(?<num>${NUMBER_CORE})` +
    String.raw`(?<abbr>(?:bn|tn|mn|mln|bln|k|m|b)(?![\p{L}\p{N}]))?` +
    String.raw`(?<decade>(?<=0)['\u2019]?s(?![\p{L}\p{N}]))?` +
    String.raw`(?<exp>\u207B?[\u2070\u00B9\u00B2\u00B3\u2074-\u2079]+)?` +
    String.raw`(?:\s?(?<pct>%)|\s+(?<pctw>per\s?cent)(?![\p{L}\p{N}]))?` +
    String.raw`(?:(?:\s+|\s*-\s*)(?<scale>thousand|million|billion|trillion)s?(?![\p{L}\p{N}]))?`,
  'giu',
);

const SUPERSCRIPT: Record<string, string> = {
  '\u2070': '0',
  '\u00B9': '1',
  '\u00B2': '2',
  '\u00B3': '3',
  '\u2074': '4',
  '\u2075': '5',
  '\u2076': '6',
  '\u2077': '7',
  '\u2078': '8',
  '\u2079': '9',
  '\u207B': '-',
};

export function extractNumbers(text: string): string[] {
  return [...text.matchAll(NUMERAL)].map((m) => {
    const g = m.groups ?? {};
    const sign = g.sign ? '-' : '';
    let num = (g.num ?? '').replaceAll(',', '');
    if (num.startsWith('.')) num = `0${num}`;
    const abbr = g.abbr ? g.abbr.toLowerCase() : '';
    const decade = g.decade ? 's' : '';
    const exp = g.exp ? `^${Array.from(g.exp, (ch) => SUPERSCRIPT[ch] ?? '').join('')}` : '';
    const pct = g.pct || g.pctw ? '%' : '';
    const scale = g.scale ? ` ${g.scale.toLowerCase()}` : '';
    return `${sign}${num}${abbr}${decade}${exp}${pct}${scale}`;
  });
}

export function unsupportedNumbers(draft: string, excerpts: string[]): string[] {
  const supported = new Set(excerpts.flatMap(extractNumbers));
  return [...new Set(extractNumbers(draft))].filter((n) => !supported.has(n));
}

const NUMERAL = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

export function extractNumbers(text: string): string[] {
  return [...text.matchAll(NUMERAL)].map((m) => m[0].replaceAll(',', ''));
}

export function unsupportedNumbers(draft: string, excerpts: string[]): string[] {
  const supported = new Set(excerpts.flatMap(extractNumbers));
  return [...new Set(extractNumbers(draft))].filter((n) => !supported.has(n));
}

const NUMERAL = /(?:(?<![\p{L}\p{N}])[-\u2212])?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|(?<!\d)\.\d+)/gu;

export function extractNumbers(text: string): string[] {
  return [...text.matchAll(NUMERAL)].map((m) => {
    let canonical = m[0].replaceAll(',', '').replace('\u2212', '-');
    // Add leading 0 to decimals: .5 → 0.5, -.25 → -0.25
    canonical = canonical.replace(/^(-)?\./, '$10.');
    return canonical;
  });
}

export function unsupportedNumbers(draft: string, excerpts: string[]): string[] {
  const supported = new Set(excerpts.flatMap(extractNumbers));
  return [...new Set(extractNumbers(draft))].filter((n) => !supported.has(n));
}

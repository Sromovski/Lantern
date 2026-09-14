/** Marker lines Project Gutenberg puts around every book ("THE" in current files, "THIS" in older ones). */
const START_MARKER = /^\*\*\* ?START OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*[ \t]*\r?$/m;
const END_MARKER = /^\*\*\* ?END OF (?:THE|THIS) PROJECT GUTENBERG EBOOK[^\n]*\*\*\*[ \t]*\r?$/m;

export class GutenbergMarkerError extends Error {
  override name = 'GutenbergMarkerError';
}

/** True when the text carries the END marker, i.e. it was downloaded completely. */
export function hasGutenbergEndMarker(text: string): boolean {
  return END_MARKER.test(text);
}

/**
 * The book itself: everything strictly between the START and END marker lines. A missing or
 * out-of-order marker means a truncated download or an unknown format, so this refuses rather than
 * guessing, and license text can never become a quote.
 */
export function stripGutenbergWrapper(text: string): string {
  const start = START_MARKER.exec(text);
  const end = END_MARKER.exec(text);
  if (start === null) throw new GutenbergMarkerError('Project Gutenberg START marker not found');
  if (end === null) throw new GutenbergMarkerError('Project Gutenberg END marker not found (truncated text?)');
  const from = start.index + start[0].length;
  if (end.index < from) throw new GutenbergMarkerError('Project Gutenberg END marker precedes the START marker');
  return text.slice(from, end.index);
}

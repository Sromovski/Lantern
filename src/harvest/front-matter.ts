/** The heading that opens a book's first chapter, stave, book, part or act. */
const FIRST_HEADING = /^[\s[]*(?:(?:CHAPTER|Chapter|STAVE|Stave|BOOK|Book|PART|Part|ACT|Act)\s+(?:I|1|ONE|One|THE FIRST|the First)\b|FIRST ACT\b)/;
/** Any numbered chapter-like heading. */
const ANY_HEADING =
  /^[\s[]*(?:(?:CHAPTER|Chapter|STAVE|Stave|BOOK|Book|PART|Part|ACT|Act)\s+(?:[IVXLC]+|\d+|ONE|One|THE \w+|the \w+)\b|(?:FIRST|SECOND|THIRD|FOURTH|FIFTH) ACT\b)/;
/** A heading line is short; a longer line that starts with "Chapter I" is prose. */
const MAX_HEADING_LENGTH = 72;
/** The body under a real first heading runs on; a contents entry has at most a line or two before the next heading. */
const MIN_BODY_LINES = 5;

export interface BookBody {
  /** The text from the first chapter (or act) heading on, byte for byte. */
  text: string;
  /** That heading line, trimmed. */
  heading: string;
  /** How many lines of front matter were dropped. */
  skippedLines: number;
}

function isFirstHeading(line: string): boolean {
  const match = FIRST_HEADING.exec(line);
  if (match === null || line.trim().length > MAX_HEADING_LENGTH) return false;
  // "Chapter I of the novel opens..." continues a sentence; a heading's title, if any, does not start lowercase.
  const rest = line.slice(match[0].length).replace(/^[\s.,:;\]\-\u2013\u2014]+/, '');
  return !/^[a-z]/.test(rest);
}

/** Whether at least MIN_BODY_LINES non-blank lines follow `index` before the next numbered heading. */
function hasBodyAfter(lines: readonly string[], index: number): boolean {
  let bodyLines = 0;
  for (let j = index + 1; j < lines.length && bodyLines < MIN_BODY_LINES; j++) {
    const line = lines[j]!;
    if (ANY_HEADING.test(line)) return false;
    if (line.trim().length > 0) bodyLines++;
  }
  return bodyLines >= MIN_BODY_LINES;
}

/**
 * Drops the front matter before a book's first chapter or act heading: title pages, contents, and
 * prefaces or introductions that may be by someone other than the author (Project Gutenberg #1342
 * carries George Saintsbury's preface, and Gutendex lists no editor for it). A first heading counts
 * only when it is heading-shaped and at least MIN_BODY_LINES non-blank lines follow it before the
 * next numbered heading, which passes over contents entries however they wrap, a "Book the First"
 * line directly above its first chapter, and prose that happens to start with "Chapter I".
 * Returns null when there is no such heading, so the harvester skips the book rather than guess
 * where the author's own words begin.
 */
export function bookBody(strippedText: string): BookBody | null {
  const lines = strippedText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!isFirstHeading(line) || !hasBodyAfter(lines, i)) continue;
    return { text: lines.slice(i).join('\n'), heading: line.trim(), skippedLines: i };
  }
  return null;
}

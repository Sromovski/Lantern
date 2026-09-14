/** A first chapter, stave or act heading. These are tried first. */
const FIRST_CHAPTER = /^[\s[]*(?:(?:CHAPTER|Chapter|STAVE|Stave|ACT|Act)\s+(?:I|1|ONE|One|THE FIRST|the First)\b|FIRST ACT\b)/;
/** A first book or part heading, tried only when no chapter, stave or act heading starts a body (an introduction can have its own PART I). */
const FIRST_PART = /^[\s[]*(?:BOOK|Book|PART|Part)\s+(?:I|1|ONE|One|THE FIRST|the First)\b/;
/** Any numbered chapter-like heading. */
const ANY_HEADING =
  /^[\s[]*(?:(?:CHAPTER|Chapter|STAVE|Stave|BOOK|Book|PART|Part|ACT|Act)\s+(?:[IVXLC]+|\d+|ONE|One|THE \w+|the \w+)\b|(?:FIRST|SECOND|THIRD|FOURTH|FIFTH) ACT\b)/;
/** Editorial matter after the text: a transcriber's note, or a capitalised notes, appendix, glossary or index label. */
const END_MATTER =
  /^[\s[]*(?:(?:TRANSCRIBER|Transcriber)['\u2019]?[Ss]? (?:NOTES?|[Nn]otes?)\b|(?:FOOTNOTES|ENDNOTES|NOTES|APPENDIX|GLOSSARY|INDEX)\b[^a-z]*$)/;
/** A heading line is short; a longer line that starts with "Chapter I" is prose. */
const MAX_HEADING_LENGTH = 72;
/** A heading stands as its own short paragraph (the heading, perhaps a title or an illustration caption). */
const MAX_HEADING_PARAGRAPH_LINES = 3;
/** A real first chapter runs on; contents entries and lists between them stop well short of this. */
const MIN_BODY_LINES = 20;

export interface BookBody {
  /** The text from the first heading up to any end matter, byte for byte. */
  text: string;
  /** That heading line, trimmed. */
  heading: string;
  /** How many lines of front matter were dropped. */
  skippedLines: number;
  /** The character offset of `text` within the text passed to bookBody. */
  offset: number;
}

const isBlank = (line: string) => line.trim().length === 0;

/** Whether the paragraph (run of non-blank lines) containing `index` has at most MAX_HEADING_PARAGRAPH_LINES lines. */
function inShortParagraph(lines: readonly string[], index: number): boolean {
  let count = 1;
  for (let j = index - 1; j >= 0 && !isBlank(lines[j]!); j--) if (++count > MAX_HEADING_PARAGRAPH_LINES) return false;
  for (let j = index + 1; j < lines.length && !isBlank(lines[j]!); j++) if (++count > MAX_HEADING_PARAGRAPH_LINES) return false;
  return true;
}

function isFirstHeading(lines: readonly string[], index: number, heading: RegExp): boolean {
  const line = lines[index]!;
  const match = heading.exec(line);
  if (match === null || line.trim().length > MAX_HEADING_LENGTH) return false;
  // "Chapter I of the novel opens..." continues a sentence; a heading's title, if any, does not start lowercase.
  const rest = line.slice(match[0].length).replace(/^[\s.,:;\]\-\u2013\u2014]+/, '');
  if (/^[a-z]/.test(rest)) return false;
  return inShortParagraph(lines, index);
}

/** Whether at least MIN_BODY_LINES non-blank lines follow `index` before the next numbered heading. */
function hasBodyAfter(lines: readonly string[], index: number): boolean {
  let bodyLines = 0;
  for (let j = index + 1; j < lines.length && bodyLines < MIN_BODY_LINES; j++) {
    const line = lines[j]!;
    if (ANY_HEADING.test(line)) return false;
    if (!isBlank(line)) bodyLines++;
  }
  return bodyLines >= MIN_BODY_LINES;
}

function findStart(lines: readonly string[]): number {
  for (const heading of [FIRST_CHAPTER, FIRST_PART]) {
    for (let i = 0; i < lines.length; i++) {
      if (isFirstHeading(lines, i, heading) && hasBodyAfter(lines, i)) return i;
    }
  }
  return -1;
}

/**
 * The author's text within a Project Gutenberg book, with the wrapper already stripped.
 *
 * The front matter before the first chapter, stave or act heading is dropped: title pages, contents,
 * and prefaces or introductions that may be by someone other than the author (Project Gutenberg
 * #1342 carries George Saintsbury's preface, and Gutendex lists no editor for it). A book or part
 * heading is used only when the book has no such heading. A first heading counts only when it is
 * heading-shaped (short, not a sentence that continues in lowercase, standing in a paragraph of at
 * most MAX_HEADING_PARAGRAPH_LINES lines) and at least MIN_BODY_LINES non-blank lines follow it
 * before the next numbered heading. That passes over contents entries and the lists between them,
 * a "Book the First" line directly above its first chapter, and prose that starts a line with
 * "Chapter I".
 *
 * The text also stops at the first end-matter label after the heading (a transcriber's note, or
 * NOTES, FOOTNOTES, ENDNOTES, APPENDIX, GLOSSARY or INDEX), since what follows is editorial.
 *
 * Returns null when no heading qualifies, so the harvester skips the book rather than guess where
 * the author's own words begin.
 */
export function bookBody(strippedText: string): BookBody | null {
  const lines = strippedText.split('\n');
  const start = findStart(lines);
  if (start === -1) return null;
  const lineStart = (index: number) => {
    let at = 0;
    for (let i = 0; i < index; i++) at += lines[i]!.length + 1;
    return at;
  };
  let end = strippedText.length;
  for (let j = start + 1; j < lines.length; j++) {
    if (END_MATTER.test(lines[j]!)) {
      end = lineStart(j);
      break;
    }
  }
  const offset = lineStart(start);
  return { text: strippedText.slice(offset, end), heading: lines[start]!.trim(), skippedLines: start, offset };
}

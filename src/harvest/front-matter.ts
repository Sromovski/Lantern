/** The heading that opens a book's first chapter, stave, book, part or act. */
const FIRST_HEADING = /^[\s[]*(?:(?:CHAPTER|Chapter|STAVE|Stave|BOOK|Book|PART|Part|ACT|Act)\s+(?:I|1|ONE|One|THE FIRST|the First)\b|FIRST ACT\b)/;
/** Any numbered chapter-like heading. Headings that follow one another are a table of contents. */
const ANY_HEADING =
  /^[\s[]*(?:(?:CHAPTER|Chapter|STAVE|Stave|BOOK|Book|PART|Part|ACT|Act)\s+(?:[IVXLC]+|\d+|ONE|One|THE \w+|the \w+)\b|(?:FIRST|SECOND|THIRD|FOURTH|FIFTH) ACT\b)/;

export interface BookBody {
  /** The text from the first chapter (or act) heading on, byte for byte. */
  text: string;
  /** That heading line, trimmed. */
  heading: string;
  /** How many lines of front matter were dropped. */
  skippedLines: number;
}

/**
 * Drops the front matter before a book's first chapter or act heading: title pages, contents, and
 * prefaces or introductions that may be by someone other than the author (Project Gutenberg #1342
 * carries George Saintsbury's preface, and Gutendex lists no editor for it). A heading followed
 * within two non-blank lines by another heading is a table-of-contents entry and is passed over.
 * Returns null when there is no such heading, so the harvester skips the book rather than guess
 * where the author's own words begin.
 */
export function bookBody(strippedText: string): BookBody | null {
  const lines = strippedText.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (!FIRST_HEADING.test(line)) continue;
    const following: string[] = [];
    for (let j = i + 1; j < lines.length && following.length < 2; j++) {
      if (lines[j]!.trim().length > 0) following.push(lines[j]!);
    }
    if (following.some((l) => ANY_HEADING.test(l))) continue;
    return { text: lines.slice(i).join('\n'), heading: line.trim(), skippedLines: i };
  }
  return null;
}

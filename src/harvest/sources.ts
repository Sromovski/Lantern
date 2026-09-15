import { cachedFetch, type CachedResult } from '../lib/cache.js';
import { fetchWithRetry, type HttpOptions, type HttpResult } from '../lib/http.js';
import { assertSourceAllowed, SourcePolicyError } from '../verify/source-policy.js';
import { listedSections, type ListedSection } from '../verify/wikiquote.js';
import { stripGutenbergWrapper } from './gutenberg-text.js';
import { gutendexPageSchema, type GutendexBook, type HarvestAuthor } from './gutendex.js';

/** A cached GET. `source` names the cache subdirectory; `cacheable` can veto storing a response. */
export type HttpGet = (url: string, source: string, cacheable?: (result: HttpResult) => boolean) => Promise<CachedResult>;

export interface HttpGetOptions {
  cacheDir: string;
  http: HttpOptions;
  refresh?: boolean;
  now?: () => Date;
  secretValues?: readonly string[];
}

export function createHttpGet(options: HttpGetOptions): HttpGet {
  return (url, source, cacheable) =>
    cachedFetch(
      { url },
      { cacheDir: options.cacheDir, source, refresh: options.refresh, now: options.now, cacheable, secretValues: options.secretValues },
      (req) => fetchWithRetry(req, options.http),
    );
}

/** A source answered with something other than 200. */
export class SourceStatusError extends Error {
  override name = 'SourceStatusError';

  constructor(
    readonly url: string,
    readonly status: number,
  ) {
    super(`HTTP ${status} from ${url}`);
  }
}

function expectOk(result: CachedResult): CachedResult {
  if (result.status !== 200) throw new SourceStatusError(result.url, result.status);
  return result;
}

export interface Endpoints {
  gutendex: string;
  wikiquote: string;
}

export const DEFAULT_ENDPOINTS: Endpoints = { gutendex: 'https://gutendex.com', wikiquote: 'https://en.wikiquote.org' };

/** Gutendex is slow and a surname search can run to many pages; this caps the requests per author. */
export const MAX_GUTENDEX_PAGES = 10;

export function gutendexSearchUrl(endpoints: Endpoints, author: HarvestAuthor): string {
  const surname = author.gutendex_name.split(', ')[0]!.toLowerCase();
  return `${endpoints.gutendex}/books/?languages=en&search=${encodeURIComponent(surname)}`;
}

/**
 * Every English Gutendex result for the author's surname, following `next` links for at most
 * MAX_GUTENDEX_PAGES pages. A page that is not the recorded shape throws, and so does a `next` link to
 * another origin. The caller still filters with harvestableBooks.
 */
export async function gutendexBooks(get: HttpGet, endpoints: Endpoints, author: HarvestAuthor): Promise<GutendexBook[]> {
  const origin = new URL(endpoints.gutendex).origin;
  const books: GutendexBook[] = [];
  let url: string | null = gutendexSearchUrl(endpoints, author);
  for (let page = 0; url !== null && page < MAX_GUTENDEX_PAGES; page++) {
    const parsed = gutendexPageSchema.parse(JSON.parse(expectOk(await get(url, 'gutendex')).body));
    books.push(...parsed.results);
    if (parsed.next !== null && new URL(parsed.next).origin !== origin) {
      throw new Error(`Gutendex next link leaves ${origin}: ${parsed.next}`);
    }
    url = parsed.next;
  }
  return books;
}

/** Whether a response is a complete Project Gutenberg text: both its START and END markers are present. */
export function isCompleteGutenbergText(result: HttpResult): boolean {
  if (result.status !== 200) return false;
  try {
    stripGutenbergWrapper(result.body);
    return true;
  } catch {
    return false;
  }
}

function isPrimaryTextUrl(url: string): boolean {
  try {
    assertSourceAllowed({ tier: 1, url, citation: 'Project Gutenberg text', excerpt: null });
    return true;
  } catch (err) {
    if (err instanceof SourcePolicyError) return false;
    throw err;
  }
}

export interface BookText {
  /** The whole downloaded text, wrapper included. */
  text: string;
  /**
   * The url to cite as tier 1 evidence: the url after redirects, when both it and the requested url
   * are primary-text urls (spec section 8). Null otherwise, so the book yields no tier 1 evidence.
   */
  citedUrl: string | null;
  fromCache: boolean;
}

/** A book's plain text. Only a complete text (START and END markers) is cached. */
export async function bookText(get: HttpGet, url: string): Promise<BookText> {
  const result = expectOk(await get(url, 'gutenberg-text', isCompleteGutenbergText));
  const finalUrl = result.finalUrl ?? url;
  return { text: result.body, citedUrl: isPrimaryTextUrl(url) && isPrimaryTextUrl(finalUrl) ? finalUrl : null, fromCache: result.fromCache };
}

/** The Wikiquote page checked for an author: the page named after them, as for the four configured authors. */
export function wikiquotePageTitle(author: HarvestAuthor): string {
  return author.name;
}

export function wikiquotePageUrl(endpoints: Endpoints, title: string): string {
  const page = encodeURIComponent(title.replace(/ /g, '_'));
  return `${endpoints.wikiquote}/w/api.php?action=parse&format=json&formatversion=2&prop=wikitext&page=${page}`;
}

/** The Misattributed and Disputed sections of the author's Wikiquote page, from one request. */
export async function wikiquoteListedSections(get: HttpGet, endpoints: Endpoints, title: string): Promise<ListedSection[]> {
  return listedSections(JSON.parse(expectOk(await get(wikiquotePageUrl(endpoints, title), 'wikiquote')).body));
}

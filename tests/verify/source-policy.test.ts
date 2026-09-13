import { describe, it, expect } from 'vitest';
import { assertSourceAllowed, hostOf, hostsIn, isBannedSource, scanHosts, SourcePolicyError } from '../../src/verify/source-policy.js';
import { insertSource } from '../../src/db/sources.js';
import { seedItem, testDb } from '../helpers/db.js';

describe('hostOf', () => {
  it('returns a lowercase host for http(s) and null otherwise', () => {
    expect(hostOf('HTTPS://WWW.Gutenberg.org/ebooks/98')).toBe('www.gutenberg.org');
    expect(hostOf('ftp://example.com/x')).toBeNull();
    expect(hostOf('not a url')).toBeNull();
  });

  it('strips a trailing dot from the FQDN', () => {
    expect(hostOf('https://www.gutenberg.org./ebooks/98')).toBe('www.gutenberg.org');
  });
});

describe('hostsIn', () => {
  it('returns the outer host and every embedded archive or proxy target', () => {
    expect(hostsIn('https://web.archive.org/web/2019/https://www.brainyquote.com/quotes/x')).toEqual([
      'web.archive.org',
      'www.brainyquote.com',
    ]);
  });

  it('decodes percent-encoded targets up to twice', () => {
    expect(hostsIn('https://proxy.example.test/?u=https%253A%252F%252Fwww.brainyquote.com%252Fq')).toContain(
      'www.brainyquote.com',
    );
  });

  it('does not throw on malformed percent-encoding', () => {
    expect(() => hostsIn('https://x.example.test/?u=%E0%A4%A')).not.toThrow();
  });

  it.each([
    'https://web.archive.org/web/2019/https:/www.brainyquote.com/quotes/x',
    'https://web.archive.org/web/2019/https:\\\\www.brainyquote.com/x',
    'https://web.archive.org/web/2019/https:\\www.brainyquote.com/x',
    'https://proxy.example.test/?u=https:\\/\\/www.brainyquote.com/x',
    'https://proxy.example.test/?u=https%25253A%25252F%25252Fwww.brainyquote.com%25252Fq',
    'https://proxy.example.test/?u=//www.brainyquote.com/x',
    'https://proxy.example.test/?u=%2F%2Fwww.azquotes.com%2Fq',
  ])('detects the evasive embedded form %s', (url) => {
    expect(isBannedSource(url)).toBe(true);
  });
});

describe('isBannedSource', () => {
  it.each([
    'https://www.brainyquote.com/quotes/charles_dickens_121045',
    'https://goodreads.com/quotes/12345',
    'HTTPS://AZQUOTES.COM/quote/1',
    'https://m.quotefancy.com/x',
    'https://notgoodreads.com/page',
  ])('bans %s', (url) => expect(isBannedSource(url)).toBe(true));

  it.each([
    'https://www.gutenberg.org/ebooks/98',
    'https://en.wikisource.org/wiki/A_Tale_of_Two_Cities',
    'https://standardebooks.org/ebooks/charles-dickens/bleak-house',
  ])('allows %s', (url) => expect(isBannedSource(url)).toBe(false));

  it('bans a trailing-dot FQDN of a banned domain', () => {
    expect(isBannedSource('https://www.brainyquote.com./x')).toBe(true);
  });

  it('detects a banned host split by an encoded or literal tab', () => {
    expect(isBannedSource('https://web.archive.org/web/2019/https://www.brainy%09quote.com/x')).toBe(true);
    expect(isBannedSource('https://web.archive.org/web/2019/https://www.brainy\tquote.com/x')).toBe(true);
  });

  it.each([
    'https://web.archive.org/web/2019/https://www.brainyquote.com/quotes/x',
    'https://web.archive.org/web/2019id_/http://goodreads.com/quotes/1',
    'https://translate.example.test/translate?u=https%3A%2F%2Fwww.azquotes.com%2Fquote%2F1',
    'https://web.archive.org/web/2019/HTTPS://WWW.BRAINYQUOTE.COM/x',
  ])('bans the wrapped aggregator %s', (url) => expect(isBannedSource(url)).toBe(true));

  it('allows an archived public-domain text', () => {
    expect(isBannedSource('https://web.archive.org/web/2019/https://www.gutenberg.org/ebooks/98')).toBe(false);
  });
});

describe('scanHosts', () => {
  it.each([
    'https://www.gutenberg.org/files/98/98-h/98-h.htm',
    'https://en.wikisource.org/wiki/A_Tale_of_Two_Cities/Book_1/Chapter_1',
    'https://www.loc.gov/item/2021668123/?httpcode=ok',
    'https://example.edu/papers/httpx-study?topic=http-headers',
    'https://standardebooks.org/ebooks/charles-dickens/bleak-house/text/single-page',
  ])('does not flag the clean planned-source url %s', (url) => {
    expect(isBannedSource(url)).toBe(false);
    expect(scanHosts(url).truncated).toBe(false);
  });

  it('fails closed on a url longer than the length cap', () => {
    expect(isBannedSource(`https://x.example.test/?${'q'.repeat(20_000)}`)).toBe(true);
  });

  it('fails closed, quickly, when a url embeds more urls than the candidate cap', () => {
    const url = `https://x.example.test/?${'https://a.example.test/'.repeat(1000)}`;
    const started = performance.now();
    expect(scanHosts(url).truncated).toBe(true);
    expect(isBannedSource(url)).toBe(true);
    expect(performance.now() - started).toBeLessThan(500);
  });

  it('allows, quickly, a url with a modest number of embedded clean urls', () => {
    const url = `https://x.example.test/?${'https://a.example.test/'.repeat(200)}`;
    const started = performance.now();
    expect(isBannedSource(url)).toBe(false);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('assertSourceAllowed', () => {
  const ok = { tier: 1 as const, citation: 'Dickens, A Tale of Two Cities (1859), Book 1, Ch. 1' };

  it('accepts a primary source with or without a url', () => {
    expect(() => assertSourceAllowed(ok)).not.toThrow();
    expect(() => assertSourceAllowed({ ...ok, url: 'https://www.gutenberg.org/ebooks/98' })).not.toThrow();
  });

  it('rejects banned domains', () => {
    expect(() => assertSourceAllowed({ ...ok, url: 'https://www.goodreads.com/quotes/1' })).toThrow(SourcePolicyError);
  });

  it('refuses to let a reference site claim tier 1 or 2', () => {
    expect(() => assertSourceAllowed({ ...ok, url: 'https://en.wikiquote.org/wiki/Charles_Dickens' })).toThrow(/reference source/);
    expect(() => assertSourceAllowed({ ...ok, tier: 3, url: 'https://en.wikiquote.org/wiki/Charles_Dickens' })).not.toThrow();
  });

  it('refuses to let an archived reference page claim tier 1 or 2', () => {
    const archived = 'https://web.archive.org/web/2020/https://en.wikiquote.org/wiki/Charles_Dickens';
    expect(() => assertSourceAllowed({ ...ok, url: archived })).toThrow(/reference source/);
    expect(() => assertSourceAllowed({ ...ok, tier: 3, url: archived })).not.toThrow();
  });

  it('refuses an archived reference page behind a single-slash scheme at tier 1', () => {
    expect(() =>
      assertSourceAllowed({ ...ok, url: 'https://web.archive.org/web/2020/https:/en.wikiquote.org/wiki/Charles_Dickens' }),
    ).toThrow(/reference source/);
  });

  it.each([
    'https://web.archive.org/web/2020/en.wikiquote.org/wiki/Charles_Dickens',
    'https://webcache.googleusercontent.com/search?q=cache:en.wikipedia.org/wiki/Charles_Dickens',
    'https://archive.ph/en.wikiquote.org/wiki/Charles_Dickens',
  ])('refuses the scheme-less wrapped reference page %s at tier 2', (url) => {
    expect(() => assertSourceAllowed({ tier: 2, url, citation: 'c' })).toThrow(/reference source/);
  });

  it('allows a scheme-less wrapped reference page at tier 3', () => {
    expect(() =>
      assertSourceAllowed({ tier: 3, url: 'https://web.archive.org/web/2020/en.wikiquote.org/wiki/Charles_Dickens', citation: 'c' }),
    ).not.toThrow();
  });

  it.each([
    'https://www.gutenberg.org/ebooks/98?utm_source=goodreads.com',
    'https://en.wikiquote.org/wiki/Talk:Quotes.net',
    'https://webcache.googleusercontent.com/search?q=cache:www.brainyquote.com/quotes/x',
    'https://example.edu/p?ref=AZQUOTES.COM',
    'https://example.edu/notgoodreads.com/page',
  ])('refuses at every tier a url the banned-domain trigger refuses: %s', (url) => {
    expect(isBannedSource(url)).toBe(true);
    for (const tier of [1, 2, 3] as const) {
      expect(() => assertSourceAllowed({ tier, url, citation: 'c' })).toThrow(SourcePolicyError);
      expect(() => assertSourceAllowed({ tier, url, citation: 'c' })).toThrow(/banned source domain/);
    }
  });

  it('refuses a source url longer than the length cap', () => {
    expect(() => assertSourceAllowed({ ...ok, url: `https://x.example.test/?${'q'.repeat(20_000)}` })).toThrow(/longer than/);
  });

  it('rejects empty citations and unparseable urls', () => {
    expect(() => assertSourceAllowed({ ...ok, citation: '   ' })).toThrow(/citation/);
    expect(() => assertSourceAllowed({ ...ok, url: 'ftp://example.com' })).toThrow(/url/);
  });

  it('every url assertSourceAllowed accepts is accepted by the insert triggers', () => {
    const db = testDb();
    const { itemId } = seedItem(db);
    const triggerUrls = [
      'https://www.gutenberg.org/ebooks/98?utm_source=goodreads.com',
      'https://en.wikiquote.org/wiki/Talk:Quotes.net',
      'https://webcache.googleusercontent.com/search?q=cache:www.brainyquote.com/quotes/x',
      'https://example.edu/p?ref=AZQUOTES.COM',
      'https://example.edu/notgoodreads.com/page',
    ];
    const schemeLessUrls = [
      'https://web.archive.org/web/2020/en.wikiquote.org/wiki/Charles_Dickens',
      'https://webcache.googleusercontent.com/search?q=cache:en.wikipedia.org/wiki/Charles_Dickens',
      'https://archive.ph/en.wikiquote.org/wiki/Charles_Dickens',
    ];
    const cleanUrls = [
      'https://www.gutenberg.org/ebooks/98',
      'https://en.wikisource.org/w/index.php?title=Page:Bleak_House.djvu/15',
      'https://web.archive.org/web/2019id_/https://www.gutenberg.org/files/98/98-h/98-h.htm',
      'https://login.ezproxy.example.edu/login?url=https://www.jstor.org/stable/123',
    ];

    for (const url of [...triggerUrls, ...schemeLessUrls, ...cleanUrls]) {
      let refused = false;
      try {
        assertSourceAllowed({ tier: 3, url, citation: 'c' });
      } catch (err) {
        refused = true;
        expect(err).toBeInstanceOf(SourcePolicyError);
      }
      if (refused) {
        expect(() => insertSource(db, itemId, { tier: 3, url, citation: 'c' })).toThrow(SourcePolicyError);
      } else {
        expect(() => insertSource(db, itemId, { tier: 3, url, citation: 'c' })).not.toThrow();
      }
    }

    for (const url of cleanUrls) {
      expect(() => insertSource(db, itemId, { tier: 1, url, citation: 'c' })).not.toThrow();
    }
  });
});

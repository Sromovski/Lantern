import { describe, it, expect } from 'vitest';
import { assertSourceAllowed, hostOf, hostsIn, isBannedSource, SourcePolicyError } from '../../src/verify/source-policy.js';

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
});

describe('isBannedSource', () => {
  it.each([
    'https://www.brainyquote.com/quotes/charles_dickens_121045',
    'https://goodreads.com/quotes/12345',
    'HTTPS://AZQUOTES.COM/quote/1',
    'https://m.quotefancy.com/x',
  ])('bans %s', (url) => expect(isBannedSource(url)).toBe(true));

  it.each([
    'https://notgoodreads.com/page',
    'https://www.gutenberg.org/ebooks/98',
    'https://en.wikisource.org/wiki/A_Tale_of_Two_Cities',
    'https://standardebooks.org/ebooks/charles-dickens/bleak-house',
  ])('allows %s', (url) => expect(isBannedSource(url)).toBe(false));

  it('bans a trailing-dot FQDN of a banned domain', () => {
    expect(isBannedSource('https://www.brainyquote.com./x')).toBe(true);
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

  it('rejects empty citations and unparseable urls', () => {
    expect(() => assertSourceAllowed({ ...ok, citation: '   ' })).toThrow(/citation/);
    expect(() => assertSourceAllowed({ ...ok, url: 'ftp://example.com' })).toThrow(/url/);
  });
});

# Phase 2 Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the remaining Part C prerequisites that need no user decision:
- stricter numeric-claim tokens (review I6)
- a total quote gate with typed apply errors (review M1 + M10)
- archive- and proxy-wrapped banned or reference URLs (review M2)
- an HTTP request timeout, fail-fast header validation and the post-redirect URL
- deterministic cache tests
- the Phase 1 Task Scheduler doc line

**Architecture:** Every change is local to an existing module and tightens fail-closed behavior:
- `src/verify/numbers.ts`
- `src/verify/source-policy.ts`
- `src/verify/quote-gate.ts` and `src/verify/apply.ts`
- `src/lib/http.ts` and `src/lib/cache.ts`

No schema migrations. All public changes are additive or tighten an existing check. Four existing numbers assertions deliberately become stricter, and each is listed in H1.

**Tech Stack:** Node 26 (built-in `fetch`, `AbortSignal.timeout`), TypeScript 7 (strict, nodenext), vitest 5, better-sqlite3. No new dependencies.

**Spec:** `claude.md` (§2 non-negotiables, §8 verification, §11 retries, §4 scheduling). Parent plan: `plan.md` Part C prerequisite rows **Stricter numbers**, **Total gate and typed apply errors**, **Archive-wrapped aggregator URLs**, **Request timeout / `AbortSignal`**, **Fail fast on invalid caller headers**, **Final URL after redirects**.

**Deliberately NOT in this plan** (each needs a user decision or its consumer milestone):
- canonical quote body (spec §8 policy decision)
- apply-takes-evidence (2.3)
- tier-1/2 host allowlists (2.1/2.2 curated lists)
- binary downloads (2.5)
- novel-fixture size policy (2.1)

## Global Constraints

- Node.js + TypeScript, **ESM**, **strict mode on**. Relative imports use `.js` extensions.
- **Unicode:** write every non-ASCII character in code and tests as a `\u` escape, never as a literal glyph. Verify with `LC_ALL=C grep -nP '[\x80-\xFF]' <files>`, which must print nothing.
- **Fail closed.** When in doubt, a numeric claim is unsupported, a source is refused, a quote is not verified, and a fixture is not written.
- **No real internet.** HTTP tests use a throwaway `node:http` server on `127.0.0.1` port 0. Never write under `data/`; tests use OS temp dirs.
- **Never commit** `.env`, `data/`, `logs/`, or `.superpowers/`.
- **Commit trailers.** Every commit message ends with a blank line and these two lines, verified with `git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'` (must print `2`):
  - `Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>`
  - `Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v`
- **Branch.** Work on `phase-2-hardening`, created from `phase-2-foundations` at e4c6444. Baseline: 212 tests pass across 16 files.

### File map

```
src/verify/numbers.ts            # H1: scale words, superscript exponents, percent, decades, extra minus signs
tests/verify/numbers.test.ts
src/verify/source-policy.ts      # H2: hostsIn() — archive/proxy-wrapped banned and reference hosts
tests/verify/source-policy.test.ts
tests/db/source-guards.test.ts
src/verify/quote-gate.ts         # H3: positive evidence must pass assertSourceAllowed (total gate)
src/verify/apply.ts              # H3: typed errors, kind check, parseRejectReason, reopenInsufficientEvidence
tests/verify/quote-gate.test.ts
src/lib/http.ts                  # H4: timeoutMs, headers built once outside the retry loop, finalUrl
src/lib/cache.ts                 # H4: store and return finalUrl (redacted)
tests/lib/http.test.ts
tests/lib/cache.test.ts          # H4: secretValues: [] on tests that do not exercise the env path
claude.md                        # H5: Task Scheduler "Start in" line
plan.md                          # H5: status notes on the six prerequisite rows
```

---

### Task H1: Stricter numeric tokens (review I6)

**Files:**
- Modify: `src/verify/numbers.ts`
- Test: `tests/verify/numbers.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `extractNumbers(text: string): string[]` and `unsupportedNumbers(draft: string, excerpts: string[]): string[]`. The signatures are unchanged. Tokens now carry the context that changes a number's meaning, in this canonical form:

  `<sign><number>[s][^<exponent>][%][ <scale>]`

  | Part | Rule |
  |---|---|
  | sign | `-` when a minus is present |
  | number | commas stripped; a leading `.` becomes `0.` |
  | `s` | only for a decade: the number ends in `0` and is followed by `s` |
  | `^<exponent>` | superscript digits after the number, converted to ASCII |
  | `%` | for `%`, `percent` or `per cent` |
  | ` <scale>` | `thousand`, `million`, `billion` or `trillion`, lowercased with any plural `s` removed |

**Why.** Today `93 billion` is supported by `93 million`, `10³` by `10²`, `1850s` by `1850`, and `70%` by `70 countries`. A draft `40` is also supported by a source that writes `–40` with an en dash. Each of these is a real factual error slipping through a check whose whole job is catching altered numbers.

**Design decisions:**
- **Minus signs.** An ASCII hyphen, U+2212, U+2012, U+2013, U+FE63 and U+FF0D count as a minus only when no letter or digit comes directly before them. So ranges (`10–20`) and labels (`COVID-19`, `page–40`) stay unsigned.
- **Scale words are not multiplied out.** `93 million` does NOT match a source's `93,000,000`. That stays unsupported, as before: strict, fail closed, and a human resolves it in review.
- **Word boundaries.** `millionaires` is not a scale word and `percentage` is not a percent. Superscripts attach only when they directly follow a digit, so `m/s²` does not attach to `9.8`.

**Four existing assertions intentionally tighten.** These are the only sanctioned changes to existing tests:

| Test | Was | Now |
|---|---|---|
| `extractNumbers('grew by .5 percent, then fell by -.25')` | `['0.5', '-0.25']` | `['0.5%', '-0.25']` |
| `extractNumbers('the 19th century and the 1990s')` | `['19', '1990']` | `['19', '1990s']` |
| `unsupportedNumbers('Sunlight takes 8 minutes to cross 93 million miles.', [...])` | `['93']` | `['93 million']` |
| `unsupportedNumbers('grew by .5 percent', ['grew by roughly 5 percent'])` | `['0.5']` | `['0.5%']` |

The controller validated every value in this task with a scratch probe of this exact design on Node v26.0.0:
- all 10 unchanged existing assertions still pass
- the 4 tightenings produce the values above
- all 5 I6 cases, 4 equivalences and 9 extraction edge cases pass

- [ ] **Step 1: Update the four existing assertions and add the new tests** in `tests/verify/numbers.test.ts`

In `describe('extractNumbers', ...)`:
- Rename `'pulls the digits out of ordinals and decades'` to `'pulls the digits out of ordinals and marks decades'`, and change its expectation to `['19', '1990s']`.
- Change the expectation of `'normalizes leading decimals and negated decimals'` to `['0.5%', '-0.25']`.

In `describe('unsupportedNumbers', ...)`:
- Change the expectation of `'flags numbers that do not appear verbatim in a source'` to `['93 million']`.
- Change the expectation of `'flags leading decimal as unsupported when source lacks it'` to `['0.5%']`.

Append a new describe block at the end of the file:

```ts
describe('stricter numeric tokens (review I6)', () => {
  it.each([
    ['about 93 billion stars', ['about 93 million stars'], ['93 billion']],
    ['a factor of 10\u00B3', ['a factor of 10\u00B2'], ['10^3']],
    ['in the 1850s', ['in 1850'], ['1850s']],
    ['70% of readers', ['70 countries'], ['70%']],
    ['it reached 40 degrees', ['it fell to \u201340 degrees'], ['40']],
  ])('flags %j as unsupported by %j', (draft, excerpts, expected) => {
    expect(unsupportedNumbers(draft, excerpts)).toEqual(expected);
  });

  it.each([
    ['70 percent of readers', ['70% of readers']],
    ['70 per cent of readers', ['70% of readers']],
    ['3 thousands', ['3 thousand']],
    ['93 Million', ['93 million']],
  ])('treats %j as supported by %j', (draft, excerpts) => {
    expect(unsupportedNumbers(draft, excerpts)).toEqual([]);
  });

  it.each([
    ['pages 10\u201320', ['10', '20']],
    ['10\u207B\u00B3 m', ['10^-3']],
    ['the 19th', ['19']],
    ['wait 5s', ['5']],
    ['the 1990s, then', ['1990s']],
    ['93 millionaires', ['93']],
    ['a 5 percentage point rise', ['5']],
    ['see page\u201340', ['40']],
    ['it fell to \u201340 degrees', ['-40']],
  ])('extracts %j as %j', (text, expected) => {
    expect(extractNumbers(text)).toEqual(expected);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/verify/numbers.test.ts`

Expected FAIL:
- the 4 tightened assertions
- in the I6 block: all 5 `flags` cases, 3 of the 4 `supported` cases (`93 Million` already passes), and the extraction cases for `10⁻³`, `1990s` and `–40`

Record exactly which tests fail in the report.

- [ ] **Step 3: Replace `src/verify/numbers.ts` entirely**

```ts
const NUMBER_CORE = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|(?<!\d)\.\d+`;

/**
 * A numeral together with the context that changes its meaning: a minus sign (ASCII, U+2212,
 * U+2012, U+2013, U+FE63 or U+FF0D, only when no letter or digit precedes it), a decade suffix,
 * a superscript exponent, a percent, and a scale word. Scale words are kept as words, never
 * multiplied out: "93 million" does not match "93,000,000" (strict, fail closed).
 */
const NUMERAL = new RegExp(
  String.raw`(?<sign>(?<![\p{L}\p{N}])[-\u2212\u2012\u2013\uFE63\uFF0D])?` +
    `(?<num>${NUMBER_CORE})` +
    String.raw`(?<decade>(?<=0)s(?![\p{L}\p{N}]))?` +
    String.raw`(?<exp>\u207B?[\u2070\u00B9\u00B2\u00B3\u2074-\u2079]+)?` +
    String.raw`(?:\s?(?<pct>%)|\s+(?<pctw>per\s?cent)(?![\p{L}\p{N}]))?` +
    String.raw`(?:\s+(?<scale>thousand|million|billion|trillion)s?(?![\p{L}\p{N}]))?`,
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
    const decade = g.decade ? 's' : '';
    const exp = g.exp ? `^${Array.from(g.exp, (ch) => SUPERSCRIPT[ch] ?? '').join('')}` : '';
    const pct = g.pct || g.pctw ? '%' : '';
    const scale = g.scale ? ` ${g.scale.toLowerCase()}` : '';
    return `${sign}${num}${decade}${exp}${pct}${scale}`;
  });
}

export function unsupportedNumbers(draft: string, excerpts: string[]): string[] {
  const supported = new Set(excerpts.flatMap(extractNumbers));
  return [...new Set(extractNumbers(draft))].filter((n) => !supported.has(n));
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/verify/numbers.test.ts && npm test && npm run typecheck`

Expected:
- numbers: 32 tests pass (14 existing + 18 new)
- full suite: 230 across 16 files
- typecheck exits 0

Then run `LC_ALL=C grep -nP '[\x80-\xFF]' src/verify/numbers.ts tests/verify/numbers.test.ts`, which must print nothing. Note that line 6 of the existing test file already contains a literal U+2014 inside a string, and it has passed review before. If grep reports only that line, leave it and say so in the report.

- [ ] **Step 5: Commit**

```bash
git add src/verify/numbers.ts tests/verify/numbers.test.ts
git commit -m "fix(verify): numeric tokens keep scale, exponent, percent, decade and dash-minus context

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'
```

Expected: `2`.

---

### Task H2: Archive- and proxy-wrapped banned or reference URLs (review M2)

**Files:**
- Modify: `src/verify/source-policy.ts`
- Test: `tests/verify/source-policy.test.ts`, `tests/db/source-guards.test.ts`

**Interfaces:**
- Consumes: existing `hostOf`, `onDomain`, `BANNED_SOURCE_DOMAINS`, `REFERENCE_DOMAINS`, `SourcePolicyError`.
- Produces:
  - New export: `hostsIn(url: string): string[]`. It returns the URL's own http(s) host plus every host of a URL embedded in it, deduplicated, with the outer host first.
  - `isBannedSource(url)` is now true if **any** host from `hostsIn` is banned.
  - `assertSourceAllowed` now caps tier at 3 if **any** host from `hostsIn` is a reference domain.
  - Signatures are unchanged.

**Why.** `https://web.archive.org/web/2019/https://www.brainyquote.com/...` passes `assertSourceAllowed`, because its host is `web.archive.org`. It then fails the SQL trigger with a raw `SqliteError` instead of a typed `SourcePolicyError`. The same gap lets an archived Wikiquote page be cited at tier 1. Proxies such as `?u=https%3A%2F%2F...` hide the target behind percent-encoding.

**Design decisions:**
- **Decoding.** The URL text is percent-decoded up to twice, because double-encoded proxy targets exist. Malformed `%` sequences keep the text as-is and never throw.
- **Scanning.** Scan from **every** position where `http://` or `https://` starts. A greedy regex over the whole string fails here: the controller's first probe matched the outer URL only and missed the embedded one. The overlapping scan passed 11/11 probe cases:
  - Wayback `https` and `id_/http` wraps
  - percent-encoded and double-encoded proxies
  - uppercase `HTTPS`
  - archived Gutenberg still allowed
  - archived Wikiquote detected as a reference
  - `notgoodreads.com` still allowed
  - malformed `%` does not throw
- **Stricter by design.** Any URL that merely mentions a banned site as an embedded URL is refused (fail closed). A bare domain without a scheme (e.g. `?site=brainyquote.com`) is not detected. That residual is documented, and the SQL trigger's substring `LIKE` still catches it at insert time.

- [ ] **Step 1: Write the failing tests**

In `tests/verify/source-policy.test.ts`, change the import to:

```ts
import { assertSourceAllowed, hostOf, hostsIn, isBannedSource, SourcePolicyError } from '../../src/verify/source-policy.js';
```

Add a new describe block after `describe('hostOf', ...)`:

```ts
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
```

Inside `describe('isBannedSource', ...)`, add:

```ts
  it.each([
    'https://web.archive.org/web/2019/https://www.brainyquote.com/quotes/x',
    'https://web.archive.org/web/2019id_/http://goodreads.com/quotes/1',
    'https://translate.example.test/translate?u=https%3A%2F%2Fwww.azquotes.com%2Fquote%2F1',
    'https://web.archive.org/web/2019/HTTPS://WWW.BRAINYQUOTE.COM/x',
  ])('bans the wrapped aggregator %s', (url) => expect(isBannedSource(url)).toBe(true));

  it('allows an archived public-domain text', () => {
    expect(isBannedSource('https://web.archive.org/web/2019/https://www.gutenberg.org/ebooks/98')).toBe(false);
  });
```

Inside `describe('assertSourceAllowed', ...)`, add:

```ts
  it('refuses to let an archived reference page claim tier 1 or 2', () => {
    const archived = 'https://web.archive.org/web/2020/https://en.wikiquote.org/wiki/Charles_Dickens';
    expect(() => assertSourceAllowed({ ...ok, url: archived })).toThrow(/reference source/);
    expect(() => assertSourceAllowed({ ...ok, tier: 3, url: archived })).not.toThrow();
  });
```

In `tests/db/source-guards.test.ts`, inside `describe('source guards', ...)`, add:

```ts
  it('insertSource throws SourcePolicyError, not a raw SqliteError, for an archive-wrapped aggregator', () => {
    const db = testDb();
    const { itemId } = seedItem(db);
    expect(() =>
      insertSource(db, itemId, {
        tier: 2,
        citation: 'x',
        url: 'https://web.archive.org/web/2019/https://www.brainyquote.com/quotes/x',
      }),
    ).toThrow(SourcePolicyError);
    expect(count(db)).toBe(0);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/verify/source-policy.test.ts tests/db/source-guards.test.ts`

Expected FAIL:
- `hostsIn` is not exported, so the new describe block fails to import.
- The 4 wrapped-aggregator bans fail.
- The archived-reference test fails.
- The `insertSource` test fails with a raw `SqliteError` from the trigger, not `SourcePolicyError`.

The "allows an archived public-domain text" test may already pass. It is a characterization test; say so in the report.

- [ ] **Step 3: Implement** in `src/verify/source-policy.ts`

Add below `hostOf`:

```ts
const safeDecode = (value: string) => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

/**
 * Every http(s) host a URL refers to: its own host plus the host of any URL embedded in it,
 * such as an archive (web.archive.org/web/2019/https://...) or proxy (?u=https%3A%2F%2F...) target.
 * The text is percent-decoded up to twice, then scanned from every position where "http://" or
 * "https://" starts, so an embedded URL is never swallowed by the outer one.
 */
export function hostsIn(url: string): string[] {
  const hosts = new Set<string>();
  const outer = hostOf(url);
  if (outer !== null) hosts.add(outer);
  let text = url;
  for (let i = 0; i < 2; i++) text = safeDecode(text);
  const lower = text.toLowerCase();
  for (let from = 0; ; ) {
    const http = lower.indexOf('http://', from);
    const https = lower.indexOf('https://', from);
    const at = http === -1 ? https : https === -1 ? http : Math.min(http, https);
    if (at === -1) break;
    const host = hostOf(text.slice(at).split(' ')[0] ?? '');
    if (host !== null) hosts.add(host);
    from = at + 1;
  }
  return [...hosts];
}
```

Replace `isBannedSource` with:

```ts
export function isBannedSource(url: string): boolean {
  return hostsIn(url).some((host) => BANNED_SOURCE_DOMAINS.some((d) => onDomain(host, d)));
}
```

In `assertSourceAllowed`, replace everything after the `if (host === null) throw ...` line with:

```ts
  const hosts = hostsIn(src.url);
  const banned = hosts.find((h) => BANNED_SOURCE_DOMAINS.some((d) => onDomain(h, d)));
  if (banned !== undefined) throw new SourcePolicyError(`banned source domain: ${banned}`);
  if (src.tier < 3) {
    const reference = hosts.find((h) => REFERENCE_DOMAINS.some((d) => onDomain(h, d)));
    if (reference !== undefined) {
      throw new SourcePolicyError(`${reference} is a reference source and cannot be tier ${src.tier}`);
    }
  }
}
```

Keep the existing `host === null` check: an unparseable outer URL is still refused.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/verify/source-policy.test.ts tests/db/source-guards.test.ts tests/verify/quote-gate.test.ts && npm test && npm run typecheck`

Expected:
- The 10 new tests pass.
- All existing source-policy, source-guard and quote-gate tests still pass. `decideQuote`'s `usable()` calls `isBannedSource`, so wrapped aggregators are now ignored there too.
- Full suite: 240, typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/verify/source-policy.ts tests/verify/source-policy.test.ts tests/db/source-guards.test.ts
git commit -m "fix(verify): refuse archive- and proxy-wrapped aggregator and reference URLs with typed errors

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'
```

Expected: `2`.

---

### Task H3: Total quote gate and typed apply errors (review M1 + M10)

**Files:**
- Modify: `src/verify/quote-gate.ts`, `src/verify/apply.ts`
- Test: `tests/verify/quote-gate.test.ts`

**Interfaces:**
- **Consumes:**
  - `assertSourceAllowed`, `SourcePolicyError`, `SourceInput`, `SourceTier` (source-policy, now H2-aware)
  - `insertSource`
  - `normalizeText`
  - the migration 004 triggers: only `verified → raw` is blocked, so `rejected → raw` is allowed
- **Produces:**
  - `decideQuote` keeps its signature. It becomes **total**: every `verified` decision it returns is insertable, because each source passes `assertSourceAllowed`.
  - New error classes in `apply.ts`, each extending `Error`:
    - `ItemNotFoundError { itemId }`
    - `ItemNotRawError { itemId, status }`. The message keeps the substring `only raw items`.
    - `NotAQuoteError { itemId, kind }`
    - `NotReopenableError { itemId, why }`
  - `parseRejectReason(text: string): { reason: string; detail: string }` splits on the first `': '`.
  - `reopenInsufficientEvidence(db: Db, itemId: number): void`. Moves a quote rejected as `insufficient-evidence` back to `raw` with `reject_reason = NULL`, so the item can be re-verified once better evidence exists. Any other state or reason throws `NotReopenableError`.
  - `applyQuoteDecision` keeps its signature. It now throws the typed errors and refuses non-quote items.

**Why:**
- **Gate not total.** `decideQuote` can return `verified` with a source that `insertSource` rejects: a scholarly or primary URL on a reference domain, an empty citation, or (after H2) an archive-wrapped reference. `applyQuoteDecision` then throws mid-transaction. The rollback is correct, but the gate and the insert policy disagree.
- **Untyped errors.** `applyQuoteDecision` throws plain `Error`, so `lantern verify` (2.3) cannot tell "already decided, skip" from a real failure.
- **Retry needs a string match.** `--retry-insufficient` needs a safe way to reopen only `insufficient-evidence` rejects, without `LIKE 'insufficient-evidence:%'` scattered through callers.

**Design decisions:**
- **Unusable, not rejected.** Positive evidence that would fail `assertSourceAllowed` at its intended tier (primary-text 1, scholarly 2, reference 3) is treated as **unusable**, exactly like a banned URL today. The whole quote is not rejected on its account. A companion primary source still verifies on its own. With nothing usable, the result is `insufficient-evidence`. Negative evidence (misattributed, conflict) still counts regardless of its URL or citation.
- **Final rejections.** `misattributed`, `attribution-conflict`, `author-mismatch` and `too-short` are final and cannot be reopened. Only `insufficient-evidence` means "look again later".
- **No migration.** `reject_reason` keeps its `reason: detail` format; `parseRejectReason` is the one place that reads it.

- [ ] **Step 1: Write the failing tests** in `tests/verify/quote-gate.test.ts`

Change the imports to:

```ts
import {
  applyQuoteDecision,
  ItemNotFoundError,
  ItemNotRawError,
  NotAQuoteError,
  NotReopenableError,
  parseRejectReason,
  reopenInsufficientEvidence,
} from '../../src/verify/apply.js';
import { decideQuote, type QuoteEvidence } from '../../src/verify/quote-gate.js';
import { assertSourceAllowed, SourcePolicyError } from '../../src/verify/source-policy.js';
```

Append inside `describe('decideQuote', ...)`:

```ts
  it('ignores scholarly evidence whose url is a reference site', () => {
    const onReference: QuoteEvidence = { ...scholarly, url: 'https://en.wikiquote.org/wiki/Charles_Dickens' };
    expect(decideQuote(QUOTE, [onReference])).toMatchObject({ status: 'rejected', reason: 'insufficient-evidence' });
  });

  it('ignores primary-text evidence with a blank citation', () => {
    expect(decideQuote(QUOTE, [{ ...primary(), citation: '   ' }])).toMatchObject({
      status: 'rejected',
      reason: 'insufficient-evidence',
    });
  });

  it('ignores primary-text evidence on an archived reference page even when the excerpt matches', () => {
    const archived = { ...primary(), url: 'https://web.archive.org/web/2020/https://en.wikiquote.org/wiki/Charles_Dickens' };
    expect(decideQuote(QUOTE, [archived])).toMatchObject({ status: 'rejected', reason: 'insufficient-evidence' });
  });

  it('keeps a valid primary source when a companion scholarly source is invalid', () => {
    const d = decideQuote(QUOTE, [primary(), { ...scholarly, url: 'https://en.wikipedia.org/wiki/A_Tale_of_Two_Cities' }]);
    expect(d.status).toBe('verified');
    if (d.status !== 'verified') return;
    expect(d.sources.map((s) => s.tier)).toEqual([1]);
  });

  it('only ever returns verified decisions whose sources pass the insert policy', () => {
    const pool: QuoteEvidence[] = [
      primary(),
      primary(false),
      scholarly,
      wikiquote,
      { ...scholarly, url: 'https://en.wikipedia.org/wiki/X' },
      { ...primary(), citation: '' },
      { ...primary(), url: 'https://web.archive.org/web/2019/https://www.brainyquote.com/x' },
      { ...scholarly, citation: '' },
    ];
    let verified = 0;
    for (let mask = 0; mask < 1 << pool.length; mask++) {
      const evidence = pool.filter((_, i) => (mask >> i) & 1);
      const d = decideQuote(QUOTE, evidence);
      if (d.status !== 'verified') continue;
      verified++;
      for (const source of d.sources) expect(() => assertSourceAllowed(source)).not.toThrow();
    }
    expect(verified).toBeGreaterThan(0);
  });
```

Append inside `describe('applyQuoteDecision', ...)`:

```ts
  it('throws ItemNotRawError for an item that was already decided', () => {
    const db = testDb();
    const { itemId } = seedItem(db, QUOTE);
    applyQuoteDecision(db, itemId, decideQuote(QUOTE, [wikiquote]));
    expect(() => applyQuoteDecision(db, itemId, decideQuote(QUOTE, [primary()]))).toThrow(ItemNotRawError);
  });

  it('throws ItemNotFoundError for a missing item', () => {
    const db = testDb();
    expect(() => applyQuoteDecision(db, 9999, decideQuote(QUOTE, [primary()]))).toThrow(ItemNotFoundError);
  });

  it('refuses to apply a quote decision to a non-quote item', () => {
    const db = testDb();
    const { verticalId } = seedItem(db, QUOTE);
    const factId = Number(
      db
        .prepare(
          "INSERT INTO items (vertical_id, kind, body, body_hash, status, created_at) VALUES (?, 'fact', 'Water boils at 100 C at sea level', 'fact-hash-1', 'raw', '2026-01-01T00:00:00.000Z')",
        )
        .run(verticalId).lastInsertRowid,
    );
    expect(() => applyQuoteDecision(db, factId, decideQuote(QUOTE, [primary()]))).toThrow(NotAQuoteError);
    expect(db.prepare('SELECT COUNT(*) FROM sources').pluck().get()).toBe(0);
  });
```

Append these new describe blocks at the end of the file:

```ts
describe('parseRejectReason', () => {
  it.each([
    ['insufficient-evidence: reference sources only', { reason: 'insufficient-evidence', detail: 'reference sources only' }],
    ['misattributed: Wikiquote: Misattributed', { reason: 'misattributed', detail: 'Wikiquote: Misattributed' }],
    ['unparseable', { reason: 'unparseable', detail: '' }],
  ])('parses %j', (text, expected) => {
    expect(parseRejectReason(text)).toEqual(expected);
  });
});

describe('reopenInsufficientEvidence', () => {
  const statusOf = (db: ReturnType<typeof testDb>, id: number) =>
    db.prepare('SELECT status, reject_reason FROM items WHERE id = ?').get(id);

  it('reopens an insufficient-evidence rejection so the quote can be verified later', () => {
    const db = testDb();
    const { itemId } = seedItem(db, QUOTE);
    applyQuoteDecision(db, itemId, decideQuote(QUOTE, [wikiquote]));
    reopenInsufficientEvidence(db, itemId);
    expect(statusOf(db, itemId)).toEqual({ status: 'raw', reject_reason: null });
    applyQuoteDecision(db, itemId, decideQuote(QUOTE, [primary()]));
    expect(statusOf(db, itemId)).toMatchObject({ status: 'verified' });
  });

  it('refuses to reopen a final rejection', () => {
    const db = testDb();
    const { itemId } = seedItem(db, QUOTE);
    const listed: QuoteEvidence = { kind: 'listed-misattributed', citation: 'Wikiquote: Misattributed' };
    applyQuoteDecision(db, itemId, decideQuote(QUOTE, [listed]));
    expect(() => reopenInsufficientEvidence(db, itemId)).toThrow(NotReopenableError);
    expect(statusOf(db, itemId)).toMatchObject({ status: 'rejected' });
  });

  it('refuses to reopen a raw item', () => {
    const db = testDb();
    const { itemId } = seedItem(db, QUOTE);
    expect(() => reopenInsufficientEvidence(db, itemId)).toThrow(NotReopenableError);
  });

  it('refuses to reopen a verified item', () => {
    const db = testDb();
    const { itemId } = seedItem(db, QUOTE);
    applyQuoteDecision(db, itemId, decideQuote(QUOTE, [primary()]));
    expect(() => reopenInsufficientEvidence(db, itemId)).toThrow(NotReopenableError);
    expect(statusOf(db, itemId)).toMatchObject({ status: 'verified' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/verify/quote-gate.test.ts`

Expected: FAIL. The new imports do not exist yet, so the file fails to load. Record that in the report. Then temporarily stub nothing; move straight on to Step 3. For per-test RED evidence, first add only the gate tests (with the old imports kept plus `assertSourceAllowed`) and run them. Expected result of that run:

- These fail today:
  - `'ignores scholarly evidence whose url is a reference site'` (verifies at tier 2)
  - `'ignores primary-text evidence with a blank citation'`
  - `'ignores primary-text evidence on an archived reference page...'`
  - `'keeps a valid primary source when a companion scholarly source is invalid'` (tiers `[1, 2]`)
  - the pool property test
- H2 already prevents archive-wrapped **banned** URLs from counting, so the archived-*reference* case is the one that still fails here.

Report the exact failures.

- [ ] **Step 3: Implement the total gate** in `src/verify/quote-gate.ts`

Change the source-policy import to:

```ts
import { assertSourceAllowed, SourcePolicyError, type SourceInput, type SourceTier } from './source-policy.js';
```

Replace the `usable` constant (and its doc comment) with:

```ts
/**
 * Positive evidence (primary-text, scholarly, reference) counts only if the source it would
 * become passes the insert-time policy at its intended tier: a banned, archive-wrapped,
 * reference-domain-at-tier-1/2, unparseable-url or blank-citation source counts for nothing.
 * This makes decideQuote total: every verified decision it returns is insertable.
 * Negative evidence (listed-misattributed, attribution-conflict) always counts, whatever its
 * url, because a hard-reject signal must not be dodgeable by a relative or protocol-relative
 * href -- exactly the shape MediaWiki output produces.
 */
const usableAs =
  (tier: SourceTier) =>
  (e: { citation: string; url?: string; excerpt?: string }): boolean => {
    try {
      assertSourceAllowed(toSource(tier, e));
      return true;
    } catch (err) {
      if (err instanceof SourcePolicyError) return false;
      throw err;
    }
  };
```

Replace the three evidence-filter lines with:

```ts
  const primaries = of('primary-text').filter(usableAs(1)).filter((e) => excerptMatches(quote, e));
  const byAuthor = primaries.filter((e) => e.authorMatches);
  const scholarly = of('scholarly').filter(usableAs(2));
  const references = of('reference').filter(usableAs(3)).map((e) => toSource(3, e));
```

`toSource` must be declared above `usableAs`. It already is.

- [ ] **Step 4: Implement typed errors, the kind check, parsing and reopening**

Replace `src/verify/apply.ts` entirely:

```ts
import { insertSource } from '../db/sources.js';
import type { Db } from '../db/connection.js';
import type { QuoteDecision } from './quote-gate.js';

export class ItemNotFoundError extends Error {
  override name = 'ItemNotFoundError';

  constructor(readonly itemId: number) {
    super(`item ${itemId} not found`);
  }
}

export class ItemNotRawError extends Error {
  override name = 'ItemNotRawError';

  constructor(
    readonly itemId: number,
    readonly status: string,
  ) {
    super(`item ${itemId} is ${status}; only raw items can be decided`);
  }
}

export class NotAQuoteError extends Error {
  override name = 'NotAQuoteError';

  constructor(
    readonly itemId: number,
    readonly kind: string,
  ) {
    super(`item ${itemId} is a ${kind}, not a quote`);
  }
}

export class NotReopenableError extends Error {
  override name = 'NotReopenableError';

  constructor(
    readonly itemId: number,
    readonly why: string,
  ) {
    super(`item ${itemId} cannot be reopened: ${why}`);
  }
}

/** reject_reason is stored as "<reason>: <detail>"; this is the one place that reads it. */
export function parseRejectReason(text: string): { reason: string; detail: string } {
  const at = text.indexOf(': ');
  return at === -1 ? { reason: text, detail: '' } : { reason: text.slice(0, at), detail: text.slice(at + 2) };
}

interface ItemRow {
  status: string;
  kind: string;
  reject_reason: string | null;
}

function loadQuote(db: Db, itemId: number): ItemRow {
  const item = db.prepare('SELECT status, kind, reject_reason FROM items WHERE id = ?').get(itemId) as
    | ItemRow
    | undefined;
  if (!item) throw new ItemNotFoundError(itemId);
  if (item.kind !== 'quote') throw new NotAQuoteError(itemId, item.kind);
  return item;
}

/** The only code path that moves a quote item out of 'raw'. */
export function applyQuoteDecision(db: Db, itemId: number, decision: QuoteDecision, now: Date = new Date()): void {
  db.transaction(() => {
    const item = loadQuote(db, itemId);
    if (item.status !== 'raw') throw new ItemNotRawError(itemId, item.status);

    if (decision.status === 'verified') {
      for (const source of decision.sources) insertSource(db, itemId, source, now);
      db.prepare("UPDATE items SET status = 'verified', reject_reason = NULL WHERE id = ?").run(itemId);
    } else {
      db.prepare("UPDATE items SET status = 'rejected', reject_reason = ? WHERE id = ?").run(
        `${decision.reason}: ${decision.detail}`,
        itemId,
      );
    }
  })();
}

/**
 * Moves a quote rejected for insufficient evidence back to 'raw' so it can be re-verified once
 * better evidence exists. Every other rejection reason is final, and raw or verified items are
 * refused.
 */
export function reopenInsufficientEvidence(db: Db, itemId: number): void {
  db.transaction(() => {
    const item = loadQuote(db, itemId);
    if (item.status !== 'rejected') throw new NotReopenableError(itemId, `status is ${item.status}`);
    const { reason } = parseRejectReason(item.reject_reason ?? '');
    if (reason !== 'insufficient-evidence') {
      throw new NotReopenableError(itemId, `rejected as ${reason}, which is final`);
    }
    db.prepare("UPDATE items SET status = 'raw', reject_reason = NULL WHERE id = ?").run(itemId);
  })();
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/verify/quote-gate.test.ts && npm test && npm run typecheck`

Expected:
- quote-gate: the 15 new tests pass, and every existing decideQuote and applyQuoteDecision test still passes unchanged. The existing "refuses to re-decide an item that is not raw" test still matches `/only raw items/`.
- Full suite: 255. Typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add src/verify/quote-gate.ts src/verify/apply.ts tests/verify/quote-gate.test.ts
git commit -m "fix(verify): make the quote gate total; typed apply errors and insufficient-evidence reopening

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'
```

Expected: `2`.

---

### Task H4: HTTP request timeout, fail-fast headers, post-redirect URL; deterministic cache tests

**Files:**
- Modify: `src/lib/http.ts`, `src/lib/cache.ts`
- Test: `tests/lib/http.test.ts`, `tests/lib/cache.test.ts`

**Interfaces:**
- **Consumes:** the existing `fetchWithRetry` loop and the `cachedFetch` write/read paths.
- **Produces:**
  - `HttpOptions.timeoutMs?: number`. Defaults to `60_000`. Each attempt gets its own `AbortSignal.timeout(timeoutMs)`, and that signal also covers the body read. A timeout rejects with a `TimeoutError`, which is retried like any network failure and ends as `HttpError` with that `cause`. A value that is not a positive finite number throws `RangeError` before any request.
  - Request headers are built **once, before the retry loop**. An invalid header name or value throws the `TypeError` from `Headers` immediately, before any request and without retrying.
  - `HttpResult.finalUrl?: string` (additive, optional). `fetchWithRetry` sets it to `res.url || req.url`, which is the URL after redirects.
  - `cachedFetch` stores `finalUrl` redacted with `redactUrl`, includes it in the secret scan, and returns it on a cache hit when present. Entries written before this change have no `finalUrl` and still read fine.

**Why:**
- **Timeout.** A hung server, or a body that stalls after the headers, currently blocks an unattended cron harvest forever, with no error and no log line.
- **Headers.** An invalid caller header is currently retried with backoff and reported as a network `HttpError`, which hides a programming error.
- **Redirects.** A Tier 1 citation may need the post-redirect URL.
- **Test determinism.** Cache tests that omit `secretValues` read secret-named env vars from the developer's real environment, so they are environment-dependent. They fail safe, but that is not deterministic.

**Controller validation (scratch probe, Node v26.0.0):**
- `AbortSignal.timeout(150)` aborted a server that never responds, after ~161 ms.
- It aborted a body that stalled after `write('partial')`, after ~153 ms. Both rejected with `name === 'TimeoutError'`.
- `res.url` was the post-redirect URL.
- `new Headers({ 'bad header': 'x' })` threw `TypeError` synchronously.

- [ ] **Step 1: Write the failing HTTP tests** in `tests/lib/http.test.ts`

Append inside `describe('fetchWithRetry', ...)`:

```ts
  it('times out a server that never responds, retries, then throws HttpError with a TimeoutError cause', async () => {
    const server = createServer(() => {});
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { sleep, calls } = recordingSleep();
    const err = await fetchWithRetry({ url: base }, { userAgent: UA, sleep, maxAttempts: 2, timeoutMs: 100 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect(err).toMatchObject({ attempts: 2 });
    expect((err as HttpError).cause).toMatchObject({ name: 'TimeoutError' });
    expect(calls).toEqual([500]);
  });

  it('times out a body that stalls after the headers', async () => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain', 'content-length': '100' });
      res.write('partial');
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { sleep } = recordingSleep();
    const err = await fetchWithRetry({ url: base }, { userAgent: UA, sleep, maxAttempts: 1, timeoutMs: 100 }).catch(
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).cause).toMatchObject({ name: 'TimeoutError' });
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('rejects timeoutMs %s without making a request', async (timeoutMs) => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      throw new Error('unreachable');
    }) as unknown as typeof fetch;
    await expect(
      fetchWithRetry({ url: 'http://127.0.0.1:1/' }, { userAgent: UA, fetchImpl, timeoutMs }),
    ).rejects.toThrow(RangeError);
    expect(called).toBe(false);
  });

  it('rejects an invalid header name immediately, without retrying or making a request', async () => {
    let called = false;
    const fetchImpl = (async () => {
      called = true;
      throw new Error('unreachable');
    }) as unknown as typeof fetch;
    const { sleep, calls } = recordingSleep();
    await expect(
      fetchWithRetry({ url: 'http://127.0.0.1:1/', headers: { 'bad header': 'x' } }, { userAgent: UA, sleep, fetchImpl }),
    ).rejects.toThrow(TypeError);
    expect(called).toBe(false);
    expect(calls).toEqual([]);
  });

  it('reports the post-redirect URL as finalUrl', async () => {
    const server = createServer((req, res) => {
      if (req.url === '/redir') {
        res.writeHead(302, { location: '/final' });
        res.end();
      } else {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end('final body');
      }
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const { sleep } = recordingSleep();
    const res = await fetchWithRetry({ url: `${base}/redir` }, { userAgent: UA, sleep });
    expect(res).toMatchObject({ url: `${base}/redir`, finalUrl: `${base}/final`, body: 'final body' });
  });

  it('sets finalUrl to the request URL when there is no redirect', async () => {
    const srv = await scriptedServer([{ status: 200, body: 'ok' }]);
    const { sleep } = recordingSleep();
    const res = await fetchWithRetry({ url: `${srv.base}/plain` }, { userAgent: UA, sleep });
    expect(res.finalUrl).toBe(`${srv.base}/plain`);
  });

  it('falls back to the request URL when the response carries no url', async () => {
    const fetchImpl = (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;
    const res = await fetchWithRetry({ url: 'http://127.0.0.1:1/x' }, { userAgent: UA, fetchImpl });
    expect(res.finalUrl).toBe('http://127.0.0.1:1/x');
  });
```

- [ ] **Step 2: Run the HTTP tests to verify they fail**

Run: `npx vitest run tests/lib/http.test.ts`

Expected to FAIL:
- both timeout tests: with no timeout they hang until vitest's own test timeout, and that is the evidence
- the 4 `timeoutMs` cases (no `RangeError` yet)
- the invalid-header test (today it ends as `HttpError` after retries, not an immediate `TypeError`)
- all 3 `finalUrl` tests (`undefined`)

If a hanging timeout test makes the RED run slow, run `npx vitest run tests/lib/http.test.ts -t "timeoutMs|invalid header|finalUrl"` for those RED results, and record the two timeout tests' RED as "hung until the test timeout" rather than waiting it out twice. Record exactly what you ran.

- [ ] **Step 3: Implement** in `src/lib/http.ts`

Add `timeoutMs` to `HttpOptions`:

```ts
  /** Per-attempt timeout covering the request and the body read. Defaults to 60 000 ms. */
  timeoutMs?: number;
```

Add `finalUrl` to `HttpResult`:

```ts
  /** The URL after redirects (response.url), or the request URL when the response does not report one. */
  finalUrl?: string;
```

Change `DEFAULTS` to:

```ts
const DEFAULTS = { maxAttempts: 4, baseDelayMs: 500, maxDelayMs: 30_000, timeoutMs: 60_000 } as const;
```

In `fetchWithRetry`, directly after the blank-`userAgent` guard, add:

```ts
  const timeoutMs = opts.timeoutMs ?? DEFAULTS.timeoutMs;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError(`timeoutMs must be a positive finite number, got ${timeoutMs}`);
  }
  const headers = new Headers(req.headers);
  headers.set('user-agent', opts.userAgent);
```

Inside the loop's `try`, remove the two lines that build `headers`, and pass the per-attempt signal:

```ts
      res = await fetchImpl(req.url, {
        method: req.method ?? 'GET',
        headers,
        body: req.body,
        signal: AbortSignal.timeout(timeoutMs),
      });
```

Add `finalUrl` to the result object:

```ts
    const result: HttpResult = {
      url: req.url,
      finalUrl: res.url || req.url,
      status: res.status,
      headers: Object.fromEntries(res.headers.entries()),
      body,
    };
```

- [ ] **Step 4: Write the failing cache tests** in `tests/lib/cache.test.ts`

Append inside `describe('cachedFetch', ...)`:

```ts
  it('stores a redacted finalUrl and returns it on a cache hit', async () => {
    const { fetcher } = countingFetcher({ finalUrl: 'https://mirror.example.test/books/98?api_key=leak-final-url-key' });
    const req = { url: 'https://gutendex.example.test/books/98' };
    const opts = { cacheDir: dir, source: 'gutendex', now: NOW, secretValues: [] };
    const fresh = await cachedFetch(req, opts, fetcher);
    expect(fresh.finalUrl).toBe('https://mirror.example.test/books/98?api_key=leak-final-url-key');
    const hit = await cachedFetch(req, opts, fetcher);
    expect(hit).toMatchObject({ fromCache: true, finalUrl: 'https://mirror.example.test/books/98?api_key=REDACTED' });
    const [file] = readdirSync(join(dir, 'gutendex'));
    expect(readFileSync(join(dir, 'gutendex', file!), 'utf8')).not.toMatch(/leak-/);
  });

  it('reads an entry written before finalUrl existed', async () => {
    const req = { url: 'https://example.test/legacy' };
    mkdirSync(join(dir, 'example'), { recursive: true });
    writeFileSync(
      join(dir, 'example', `${cacheKey(req)}.json`),
      `${JSON.stringify({ request: { method: 'GET', url: req.url }, url: req.url, status: 200, headers: {}, body: 'old', fetchedAt: '2026-01-01T00:00:00.000Z' }, null, 2)}\n`,
    );
    const { calls, fetcher } = countingFetcher();
    const hit = await cachedFetch(req, { cacheDir: dir, source: 'example', secretValues: [] }, fetcher);
    expect(hit).toMatchObject({ fromCache: true, body: 'old' });
    expect(hit.finalUrl).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
```

**Mechanical determinism change (no assertion changes).** In `tests/lib/cache.test.ts`, add `secretValues: []` to every `CacheOptions` object literal that does not already contain `secretValues`. This covers:
- the shared `opts` constants
- the inline `{ cacheDir: dir, source: ... }` objects
- the `allowNonGet: true` object
- the non-GET test's object
- the corrupt-entry test's object

The env-derived default is still covered by the `secretEnvValues` unit test and by explicit-`secretValues` tests. No test relies on reading the real `process.env`.

Verify with:

```bash
grep -n "cacheDir:" tests/lib/cache.test.ts | grep -v secretValues
```

This may list only lines that belong to multi-line objects whose `secretValues` sits on another line (for example the veto test's `opts`). Check each one it prints.

- [ ] **Step 5: Run the cache tests to verify they fail**

Run: `npx vitest run tests/lib/cache.test.ts`

Expected FAIL: `'stores a redacted finalUrl and returns it on a cache hit'` (the hit has no `finalUrl`). `'reads an entry written before finalUrl existed'` may already pass; it is a characterization test, so say so. The `secretValues: []` additions must not change any other result.

- [ ] **Step 6: Implement** in `src/lib/cache.ts`

Add to `StoredEntry`, after `url`:

```ts
  finalUrl?: string;
```

In `readEntry`, extend the shape check with:

```ts
    (e.finalUrl !== undefined && typeof e.finalUrl !== 'string') ||
```

Place it before `typeof e.headers !== 'object' ||`.

In the cache-hit return, add after `url: req.url,`:

```ts
      ...(stored.finalUrl !== undefined ? { finalUrl: stored.finalUrl } : {}),
```

In the `entry` object, add after `url: redactUrl(result.url),`:

```ts
      ...(result.finalUrl !== undefined ? { finalUrl: redactUrl(result.finalUrl) } : {}),
```

Change the `haystack` line to include it:

```ts
    const haystack = [serialized, entry.request.url, entry.url, entry.finalUrl ?? '', ...Object.values(entry.headers), entry.body].join('\n');
```

- [ ] **Step 7: Run everything**

Run: `npx vitest run tests/lib/http.test.ts tests/lib/cache.test.ts && npm test && npm run typecheck`

Expected:
- http: 54 tests pass (44 + 10).
- cache: 37 tests pass (35 + 2).
- Full suite: 267.
- Typecheck exits 0. No hanging handles: the `afterEach` in each test file calls `closeAllConnections()`.

Then check for non-ASCII:

```bash
LC_ALL=C grep -nP '[\x80-\xFF]' src/lib/http.ts src/lib/cache.ts tests/lib/http.test.ts tests/lib/cache.test.ts
```

It must print nothing.

- [ ] **Step 8: Commit**

```bash
git add src/lib/http.ts src/lib/cache.ts tests/lib/http.test.ts tests/lib/cache.test.ts
git commit -m "fix(lib): per-attempt request timeout, fail-fast headers, post-redirect finalUrl; deterministic cache tests

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'
```

Expected: `2`.

---

### Task H5: Correct the Task Scheduler guidance; record prerequisite status

**Files:**
- Modify: `claude.md` (§4, the `node-cron` bullet), `plan.md` (Part C prerequisites status)

**Interfaces:**
- Consumes: nothing.
- Produces: documentation only. No code and no tests.

**Why:**
- **`claude.md` line 132 is wrong.** It says a Windows Task Scheduler entry "needs no 'Start in' directory". That is false for the CLI as it exists today. `npm run lantern` and `node --import tsx src/cli.ts` both resolve `tsx` and the relative script path against the working directory. Started from `C:\Windows\System32`, they fail with `ERR_MODULE_NOT_FOUND`, and the Phase 1 fix-wave re-review reproduced this. Only a compiled `node <absolute path>\dist\src\cli.js` needs no "Start in". A scheduled task configured from the current sentence would fail every run, with nothing written to `logs/`.
- **`plan.md` is stale.** This plan closes six of its Part C prerequisite rows.

- [ ] **Step 1: Fix `claude.md`**

Replace exactly these lines, which are the continuation of the `node-cron` bullet in §4:

```
  The CLI locates the project root from its own install location, not the
  working directory (override with `LANTERN_ROOT`); `.env` is read from that
  root, with shell environment variables taking precedence — so a Windows
  Task Scheduler entry needs no "Start in" directory. `lantern doctor` exits
  1 on any failed check and 0 otherwise.
```

with:

```
  The CLI locates the project root from its own install location, not the
  working directory (override with `LANTERN_ROOT`), and reads `.env` from that
  root, with shell environment variables taking precedence. Node's own module
  resolution still uses the working directory: `npm run lantern` and
  `node --import tsx src/cli.ts` need the Task Scheduler "Start in" directory
  set to the project root, and only a compiled
  `node <absolute path>\dist\src\cli.js` needs none. `lantern doctor` exits
  1 on any failed check and 0 otherwise.
```

Change nothing else in `claude.md`.

- [ ] **Step 2: Record status in `plan.md`**

Find the heading `### Prerequisites carried from the Part B final review`. Directly under it is an existing status line that begins `> **Status:** the **Normalization hardening + golden hash**`. Add a blank line after that line, then this line:

```markdown
> **Status:** the **Stricter numbers**, **Total gate and typed apply errors**, **Archive-wrapped aggregator URLs**, **Request timeout / `AbortSignal`**, **Fail fast on invalid caller headers** and **Final URL after redirects** rows are done on branch `phase-2-hardening` (docs/plans/phase-2-hardening.md, Tasks H1–H4).
```

Change nothing else in `plan.md`.

- [ ] **Step 3: Verify**

Run:

```bash
grep -n 'needs no "Start in" directory' claude.md; echo "old sentence count (must be 0): $(grep -c 'needs no "Start in" directory' claude.md)"
grep -c 'need the Task Scheduler "Start in" directory' claude.md
grep -c 'rows are done on branch `phase-2-hardening`' plan.md
git diff --stat
```

Expected:
- the old sentence is gone (0)
- the new sentence is present (1)
- the plan.md status line is present (1)
- only `claude.md` and `plan.md` changed

- [ ] **Step 4: Commit**

```bash
git add claude.md plan.md
git commit -m "docs: correct Task Scheduler Start-in guidance; record hardening prerequisite status

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'
```

Expected: `2`.

---

## Done when

- `npm test` passes with **267** tests: 212 baseline, plus 18 from H1, 10 from H2, 15 from H3, 10 + 2 from H4. `npm run typecheck` exits 0.
- `LC_ALL=C grep -nP '[\x80-\xFF]'` over every changed `src/` and `tests/` file prints nothing, except the pre-existing U+2014 on line 6 of `tests/verify/numbers.test.ts`, which predates this plan.
- The four H1 tightenings are the only changed assertions in existing tests.
- `claude.md` no longer claims that no "Start in" directory is needed, and `plan.md` carries the H1–H4 status line.
- Every commit carries both attribution trailers, and nothing under `data/` is tracked.

# Phase 2 Guardrails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the next set of `plan.md` Part C rows that need no user decision and no network access.

- **Tier 1 allowlist:** a tier 1 source must be a full text on the three public-domain hosts spec §8 names (**Tier 1/2 host allowlists**, first half).
- **Scholarly author check:** scholarly evidence must confirm the author (**Tier 1/2 host allowlists**, second half).
- **Doctor guardrails:**
  - A live channel with no credential fails (**Missing channel credentials**).
  - Two channels on one platform that resolve to the same account fail (the doctor half of **I6**).
  - An unset `LANTERN_CONTACT` warns (part of **Unattended retry visibility**).
- **Retry and download reporting:**
  - An `onRetry` hook on the HTTP client and the download (part of **Unattended retry visibility**).
  - `DownloadStatusError.finalUrl` (a parked minor from the prerequisites final review, needed by 2.5).
- **Paths:** `paths.cache` and `paths.media` (part of **Novel-sized fixtures** and 2.5).

**Architecture:** Every change is local to an existing module.
- `src/verify/source-policy.ts` gains `PRIMARY_TEXT_DOMAINS`. `assertSourceAllowed` refuses a tier 1 source unless every host its URL refers to is on that list. This is fail closed, and the gate inherits it through `usableAs(1)`.
- `QuoteEvidence`'s scholarly variant gains a required `authorMatches`. This is a deliberate type change, made now while no harvester builds evidence.
- The doctor gains `channels.destinations` and `env.contact`, and a live channel's missing `account_ref` becomes a `fail`.
- `HttpOptions` gains `onRetry`. `resolvePaths` gains `cache` and `media`.
- No schema migration.

**Tech Stack:** Node 26, TypeScript 7 (strict, nodenext), vitest 5, better-sqlite3 13, zod 4. No new dependencies.

**Spec:** `claude.md`. The relevant sections:
- §2: fail closed; never publish an unverified quote
- §4: logs, "a cron job leaves a log"
- §6: `channels.account_ref`
- §7: doctor
- §8: tier 1 is Project Gutenberg via Gutendex, Standard Ebooks, or Wikisource; tier 2 is scholarly with a citation
- §11: never double-post

Parent plan: `plan.md` Part C, the rows named in the Goal.

**Deliberately NOT in this plan.** Each item needs a user decision, curated data, a consumer that does not exist yet, or network access:
- canonical quote body (user decision, spec §8)
- a curated scholarly host allowlist (2.2)
- the Gutenberg END-marker `cacheable` hook and the novel-fixture size policy (2.1)
- the run deadline and retry log wiring (Phase 5; no scheduled stage calls the HTTP client yet)
- the publish-time duplicate guard, a channel-rename command, and whether a re-added channel keeps `auto_publish` (Phase 4, the rest of I6)
- the doctor exit-code contract for warnings (decide before Phase 5)
- secret-protection scope (first credentialed source)
- numbers the numeric check cannot see (Phase 7; counting words like "one" floods review, which is a product decision)

**Probe evidence.** Every design was run in scratch probes on Node 26.0.0 before this plan was written:
- **G1 allowlist, 16/16 cases.** Accepted: gutenberg.org (www and bare, ebooks, cache/epub, files with fragment, `.txt.utf-8`), standardebooks.org, and en.wikisource.org (`/wiki/` and `index.php`). Refused: the `gutenberg.pglaf.org` mirror, a Wayback-wrapped Gutenberg URL, an EZproxy-wrapped JSTOR URL, `notgutenberg.org`, `gutenberg.org.evil.test`, a Gutenberg URL embedding a Goodreads link, Wikiquote, a null url, and an unparseable url.
- **G3 config.** A temp root with a copied `config/` plus a second Facebook channel (`FB_PAGE_ID_MIRROR`) loads and syncs as 4 distinct channel ids.

## Global Constraints

- **Language.** Node.js + TypeScript, ESM, strict mode on. Relative imports use `.js` extensions.
- **Unicode.**
  - Every non-ASCII character in code and tests must be a `\u` escape. None of this plan's code needs one.
  - Verify with `git diff | grep '^+' | grep -P '[^\x00-\x7F]'` on `.ts` files; it must print nothing.
  - `src/doctor/checks.ts` already contains literal em dashes in two pre-existing strings. Add none.
  - Markdown docs keep their existing characters.
- **Fail closed.** When in doubt, a source is refused, a quote is not verified, and doctor reports a problem.
- **No secrets in doctor output.** A doctor detail never prints the value of `LANTERN_CONTACT` or of any `account_ref` variable, only variable names.
- **No real internet.**
  - HTTP tests use `node:http` on `127.0.0.1` port 0.
  - Tests use OS temp dirs and never read or write under `data/` or the real `logs/`.
  - Never touch `data/lantern.db`.
- **Never commit** `.env`, `data/`, `logs/`, or `.superpowers/`.
- **Frozen files.** Applied migration files are frozen; never edit anything under `migrations/`.
- **Commit trailers.** Every commit message ends with a blank line and two trailer lines:
  - `Co-Authored-By: <the authoring model's attribution line from its environment>`
  - `Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v`

  Verify with `git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'`, which must print `2`.
- **Branch.** Work on `phase-2-guardrails`, created from `phase-2-prerequisites` at 86bf5fa. Baseline: 353 tests pass across 17 files. The GitHub remote `origin` exists. The controller pushes after the final review; implementers never push.

### File map

```
src/verify/source-policy.ts        # G1: PRIMARY_TEXT_DOMAINS; tier 1 needs an allowlisted full-text url
tests/verify/source-policy.test.ts # G1
tests/db/source-guards.test.ts     # G1: tier 1 fixtures gain a gutenberg url
tests/db/item-guards.test.ts       # G1: tier 1 fixture gains a gutenberg url
src/verify/quote-gate.ts           # G2: scholarly evidence requires authorMatches
tests/verify/quote-gate.test.ts    # G1 (one test), G2
src/doctor/checks.ts               # G3: live account_ref fail, channels.destinations, env.contact
tests/doctor/checks.test.ts        # G3
tests/cli.test.ts                  # G3: the lantern() helper sets LANTERN_CONTACT
src/lib/http.ts                    # G4: RetryEvent, onRetry, errorReason
src/lib/download.ts                # G4: onRetry, DownloadStatusError.finalUrl
tests/lib/http.test.ts             # G4
tests/lib/download.test.ts         # G4
src/lib/paths.ts                   # G5: cache, media
tests/lib/paths.test.ts            # G5
claude.md                          # G6: section 8 tier 1 and scholarly author rule
plan.md                            # G6: status lines
```

### Test counts

| After | Suite |
|---|---|
| baseline | 353 |
| G1 | 363 |
| G2 | 365 |
| G3 | 368 |
| G4 | 372 |
| G5 | 373 |
| G6 | 373 |

---

### Task G1: Tier 1 needs a public-domain full text on an allowlisted host

**Files:**
- Modify: `src/verify/source-policy.ts`
- Test: `tests/verify/source-policy.test.ts`, `tests/verify/quote-gate.test.ts`, `tests/db/source-guards.test.ts`, `tests/db/item-guards.test.ts`

**Interfaces:**
- Consumes: the existing `hostOf`, `scanHosts`, `onDomain` and `SourcePolicyError`.
- Produces:
  - `export const PRIMARY_TEXT_DOMAINS = ['gutenberg.org', 'standardebooks.org', 'wikisource.org'] as const;`
  - `assertSourceAllowed` throws `SourcePolicyError` in two new cases:
    - A tier 1 source has no url. Message: `a tier 1 source needs the url of its full text on gutenberg.org, standardebooks.org, wikisource.org`.
    - Any scanned host is off the list. Message: `tier 1 needs a public-domain full text on gutenberg.org, standardebooks.org, wikisource.org, not <host>`.
  - Tiers 2 and 3 are unchanged.

**Why:** Plan.md row **Tier 1/2 host allowlists** (review M3): tiers are caller-asserted, with only a denylist behind them. Spec §8 defines tier 1 exactly: the string located in a public-domain full text on Project Gutenberg (via the Gutendex API), Standard Ebooks, or Wikisource. A tier 1 claim on any other host, or with no url, is therefore not tier 1.

Checking every scanned host, not just the outer one, refuses archive and proxy wrappers even when they wrap Gutenberg. A Wayback copy is not the source the spec names, and the wrapper could serve a different text. The `gutenberg.pglaf.org` mirror is refused for the same reason. Such evidence can still be cited at tier 2 or 3. The gate inherits all of this through `usableAs(1)`: primary-text evidence elsewhere simply does not count.

The check lives in TypeScript only (spec §8: `assertSourceAllowed` is authoritative). No trigger mirrors it, so no migration is needed.

- [ ] **Step 1: Write the failing tests and update tier 1 fixtures**

**1. `tests/verify/source-policy.test.ts`, first test.** Replace this test:

```ts
  it('accepts a primary source with or without a url', () => {
    expect(() => assertSourceAllowed(ok)).not.toThrow();
    expect(() => assertSourceAllowed({ ...ok, url: 'https://www.gutenberg.org/ebooks/98' })).not.toThrow();
  });
```

with this test:

```ts
  it('accepts a primary source only with the url of its public-domain full text', () => {
    expect(() => assertSourceAllowed(ok)).toThrow(/tier 1 source needs the url/);
    expect(() => assertSourceAllowed({ ...ok, url: 'https://www.gutenberg.org/ebooks/98' })).not.toThrow();
  });
```

This is a sanctioned assertion change. The spec defines tier 1 as a located public-domain full text, so a url-less tier 1 claim cannot be one.

**2. `tests/verify/source-policy.test.ts`, new tests.** Directly after that replaced test, add:

```ts
  it.each([
    'https://www.gutenberg.org/cache/epub/98/pg98.txt',
    'https://gutenberg.org/ebooks/98.txt.utf-8',
    'https://standardebooks.org/ebooks/charles-dickens/bleak-house/text/single-page',
    'https://en.wikisource.org/w/index.php?title=Page:Bleak_House.djvu/15',
  ])('accepts the public-domain full text %s at tier 1', (url) => {
    expect(() => assertSourceAllowed({ ...ok, url })).not.toThrow();
  });

  it.each([
    'https://gutenberg.pglaf.org/9/98/98-h/98-h.htm',
    'https://web.archive.org/web/2019id_/https://www.gutenberg.org/files/98/98-h/98-h.htm',
    'https://login.ezproxy.example.edu/login?url=https://www.jstor.org/stable/123',
    'https://notgutenberg.org/ebooks/98',
    'https://gutenberg.org.evil.test/ebooks/98',
  ])('refuses %s at tier 1 but allows it at tier 2', (url) => {
    expect(() => assertSourceAllowed({ ...ok, url })).toThrow(/tier 1 needs a public-domain full text/);
    expect(() => assertSourceAllowed({ ...ok, tier: 2, url })).not.toThrow();
  });
```

**3. `tests/verify/source-policy.test.ts`, trigger-parity test.** In `'every url assertSourceAllowed accepts is accepted by the insert triggers'`, replace:

```ts
    for (const url of cleanUrls) {
      expect(() => insertSource(db, itemId, { tier: 1, url, citation: 'c' })).not.toThrow();
    }
```

with:

```ts
    for (const url of cleanUrls.slice(0, 2)) {
      expect(() => insertSource(db, itemId, { tier: 1, url, citation: 'c' })).not.toThrow();
    }
    for (const url of cleanUrls.slice(2)) {
      expect(() => insertSource(db, itemId, { tier: 1, url, citation: 'c' })).toThrow(SourcePolicyError);
      expect(() => insertSource(db, itemId, { tier: 2, url, citation: 'c' })).not.toThrow();
    }
```

This is a sanctioned change. The first two clean urls are Gutenberg and Wikisource. The last two are a Wayback wrapper and an EZproxy wrapper, which are no longer tier 1.

**4. Other `assertSourceAllowed` tests.** These use `ok` (tier 1, no url) with a url that fails an earlier check: banned, reference, too long, blank citation, or unparseable. They keep their assertions unchanged. The new tier 1 check runs last, after those checks.

**5. `tests/db/source-guards.test.ts` and `tests/db/item-guards.test.ts`.** Every call of the form `insertSource(db, itemId, { tier: 1, citation: '<text>' })` becomes `insertSource(db, itemId, { tier: 1, url: 'https://www.gutenberg.org/ebooks/98', citation: '<text>' })`, keeping `<text>` unchanged. There are 7 such calls:
- `item-guards.test.ts` line 8
- `source-guards.test.ts` lines 46, 54, 64, 65, 73 and 83

Change nothing else in those files. These tests exercise triggers, not the url, so this is a fixture update, not an assertion change.

**6. `tests/verify/quote-gate.test.ts`.** Directly after the test `'ignores primary-text evidence on an archived reference page even when the excerpt matches'`, add:

```ts
  it('ignores primary-text evidence outside the public-domain full-text hosts even when the excerpt matches', () => {
    const elsewhere = { ...primary(), url: 'https://www.example.edu/dickens/a-tale-of-two-cities.txt' };
    expect(decideQuote(QUOTE, [elsewhere])).toMatchObject({ status: 'rejected', reason: 'insufficient-evidence' });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/verify/source-policy.test.ts tests/verify/quote-gate.test.ts tests/db`

Expected RED:

**Fail:**
- The replaced first test, because `ok` without a url is still accepted.
- The 5 refused-at-tier-1 cases.
- The trigger-parity test, whose two wrappers are still accepted at tier 1.
- The new quote-gate test, whose example.edu primary text still verifies.

**Pass:**
- The 4 accepted-at-tier-1 cases.
- The db tests with the added url.

Record which fail and which pass.

- [ ] **Step 3: Implement**

In `src/verify/source-policy.ts`:

1. Directly after the `REFERENCE_DOMAINS` declaration and its doc comment, add:

   ```ts
   /** Public-domain full-text hosts (spec section 8): the only places a tier 1 source may live. */
   export const PRIMARY_TEXT_DOMAINS = ['gutenberg.org', 'standardebooks.org', 'wikisource.org'] as const;
   ```

2. In `assertSourceAllowed`, replace the line `if (src.url == null) return;` with:

   ```ts
     if (src.url == null) {
       if (src.tier === 1) {
         throw new SourcePolicyError(`a tier 1 source needs the url of its full text on ${PRIMARY_TEXT_DOMAINS.join(', ')}`);
       }
       return;
     }
   ```

3. At the end of `assertSourceAllowed`, after the `if (src.tier < 3) { ... }` block and before the function's closing `}`, add:

   ```ts
     if (src.tier === 1) {
       const outside = hosts.find((h) => !PRIMARY_TEXT_DOMAINS.some((d) => onDomain(h, d)));
       if (outside !== undefined) {
         throw new SourcePolicyError(
           `tier 1 needs a public-domain full text on ${PRIMARY_TEXT_DOMAINS.join(', ')}, not ${outside}`,
         );
       }
     }
   ```

The ordering matters. The banned-domain, reference-domain, length and truncation checks keep running first, so their existing messages and tests are unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/verify tests/db && npm test && npm run typecheck`

Expected:
- All tests pass, with no other assertion edited.
- Full suite: **363**.
- Typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/verify/source-policy.ts tests/verify/source-policy.test.ts tests/verify/quote-gate.test.ts tests/db/source-guards.test.ts tests/db/item-guards.test.ts
git commit -m "fix(verify): tier 1 needs a public-domain full text on gutenberg.org, standardebooks.org or wikisource.org

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'
```

Expected: `2`.

---

### Task G2: Scholarly evidence must confirm the author

**Files:**
- Modify: `src/verify/quote-gate.ts`
- Test: `tests/verify/quote-gate.test.ts`

**Interfaces:**
- Consumes (from G1): tier 1 policy through `usableAs(1)`. No change here.
- Produces: `QuoteEvidence` scholarly variant `{ kind: 'scholarly'; citation: string; url?: string; excerpt?: string; authorMatches: boolean }`, where `authorMatches` is required. `decideQuote` handles it as follows:
  - Author-matching scholarly evidence verifies at tier 2, as before.
  - Usable scholarly evidence that only attributes the quote to someone else rejects with `author-mismatch`, unless a tier 1 match by the author exists.
  - A verified decision never carries a scholarly source for a different author.

**Why:** Plan.md row **Tier 1/2 host allowlists** says: "add `authorMatches` to scholarly evidence". Primary-text evidence already requires `authorMatches`. Scholarly evidence verifies at tier 2 with no author check at all, so an edition of Carlyle that contains the line would verify it as Dickens.

Adding a required field later would break every harvester that builds `QuoteEvidence`. No harvester exists yet (2.1/2.2), so the change is cheapest now. The rejection reason mirrors the primary-text case (`author-mismatch`), which `reopenInsufficientEvidence` treats as final.

- [ ] **Step 1: Write the failing tests**

In `tests/verify/quote-gate.test.ts`:

1. Replace the `scholarly` constant with:

   ```ts
   const scholarly: QuoteEvidence = {
     kind: 'scholarly',
     citation: 'Oxford World\'s Classics edition, p. 5',
     authorMatches: true,
   };
   const scholarlyOtherAuthor: QuoteEvidence = {
     kind: 'scholarly',
     citation: 'An anthology attributing the line to Thomas Carlyle',
     authorMatches: false,
   };
   ```

2. Directly after the test `'verifies on scholarly evidence as tier 2'`, add:

   ```ts
     it('rejects a quote that a scholarly source attributes only to a different author', () => {
       expect(decideQuote(QUOTE, [scholarlyOtherAuthor])).toMatchObject({ status: 'rejected', reason: 'author-mismatch' });
     });

     it('does not attach a scholarly source for a different author to a verified quote', () => {
       const d = decideQuote(QUOTE, [primary(), scholarlyOtherAuthor]);
       expect(d.status).toBe('verified');
       if (d.status !== 'verified') return;
       expect(d.sources.map((s) => s.tier)).toEqual([1]);
     });
   ```

Every other test keeps its assertions. The tests that spread `scholarly` (`{ ...scholarly, url: ... }`, `{ ...scholarly, citation: '' }`) inherit `authorMatches: true`.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/verify/quote-gate.test.ts && npm run typecheck`

Expected RED:
- The typecheck fails, because `authorMatches` does not exist on the scholarly variant. Record it.
- The first new test fails: the evidence verifies at tier 2 instead of rejecting.
- The second new test fails: the tiers are `[1, 2]`.

- [ ] **Step 3: Implement**

In `src/verify/quote-gate.ts`:

1. Change the scholarly line of `QuoteEvidence` to:

   ```ts
     | { kind: 'scholarly'; citation: string; url?: string; excerpt?: string; authorMatches: boolean }
   ```

2. In `decideQuote`, replace everything from the line `const primaries = of('primary-text')...` through the final `return reject('insufficient-evidence', ...)` with:

   ```ts
     const primaries = of('primary-text').filter(usableAs(1)).filter((e) => excerptMatches(quote, e));
     const byAuthor = primaries.filter((e) => e.authorMatches);
     const scholarly = of('scholarly').filter(usableAs(2));
     const scholarlyByAuthor = scholarly.filter((e) => e.authorMatches);
     const references = of('reference').filter(usableAs(3)).map((e) => toSource(3, e));

     if (byAuthor.length > 0) {
       return {
         status: 'verified',
         sources: [...byAuthor.map((e) => toSource(1, e)), ...scholarlyByAuthor.map((e) => toSource(2, e)), ...references],
       };
     }
     if (primaries.length > 0) {
       return reject('author-mismatch', `found only in works not by the attributed author: ${primaries.map((e) => e.citation).join('; ')}`);
     }
     if (scholarlyByAuthor.length > 0) {
       return { status: 'verified', sources: [...scholarlyByAuthor.map((e) => toSource(2, e)), ...references] };
     }
     if (scholarly.length > 0) {
       return reject('author-mismatch', `attested only for a different author: ${scholarly.map((e) => e.citation).join('; ')}`);
     }
     return reject('insufficient-evidence', references.length > 0 ? 'reference sources only' : 'no usable evidence');
   ```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/verify/quote-gate.test.ts && npm test && npm run typecheck`

Expected:
- All quote-gate tests pass, including the 512-subset property test.
- Full suite: **365**.
- Typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/verify/quote-gate.ts tests/verify/quote-gate.test.ts
git commit -m "fix(verify): scholarly evidence verifies only when it attributes the quote to the same author

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'
```

Expected: `2`.

---

### Task G3: Doctor guardrails for live credentials, shared destinations and the contact

**Files:**
- Modify: `src/doctor/checks.ts`
- Test: `tests/doctor/checks.test.ts`, `tests/cli.test.ts`

**Interfaces:**
- Consumes: the existing `runChecks`, `channelChecks`, `LoadedChannel` and `result`.
- Produces three doctor behaviours:
  1. `channel.<slug>.account_ref` is `fail` when the channel is live (`enabled = 1` and `auto_publish = 1`) and its env var is unset or blank. It stays `warn` for channels that are not live.
  2. A new check `channels.destinations`:
     - `fail` when two synced enabled channels on one platform have the same non-blank env value.
     - `ok` otherwise.
     - The detail names slugs and variable names, never values.
  3. A new check `env.contact`:
     - `warn` when `LANTERN_CONTACT` is unset or blank.
     - `ok` otherwise.
     - The detail never prints the contact.

**Why:**
- **Missing channel credentials** (Phase 1 review, Minor 10): a live channel with no credential should never reach `publish`.
- **I6** (Phase 1 review): channel identity is keyed on the env var name. Two names that point at the same page create two `channel_id`s, which silently defeats `UNIQUE(post_id, channel_id)` for that page (spec §6/§11). This task adds the doctor half. The publish-time guard and the rename and `auto_publish` decisions stay for Phase 4.
- **Unattended retry visibility** asks for "a `doctor` check that `LANTERN_CONTACT` is set". Every source API call needs it (`buildUserAgent` throws without it), so an unattended harvest would fail on its first request.

`LANTERN_CONTACT` holds the user's email or URL, so doctor must never echo it. The same goes for account ids.

- [ ] **Step 1: Write the failing tests**

In `tests/doctor/checks.test.ts`:

1. Add `LANTERN_CONTACT: 'test@example.invalid',` to the `ENV` constant. It becomes:

   ```ts
   const ENV = {
     FB_PAGE_ID_COMMONPLACE: '1',
     PINTEREST_BOARD_ID_COMMONPLACE: '2',
     YT_CHANNEL_ID_LOOK_CLOSER: '3',
     LANTERN_CONTACT: 'test@example.invalid',
   };
   ```

   This is a fixture update. It keeps `'reports a healthy empty system with no warnings or failures'` true once `env.contact` exists.

2. Add these tests at the end of `describe('runChecks', ...)`:

   ```ts
     it('fails when a live channel has no account credential', () => {
       const ctx = healthyCtx({ env: { ...ENV, FB_PAGE_ID_COMMONPLACE: '' } });
       expect(byName(ctx, 'channel.literature-facebook.account_ref')).toMatchObject({ status: 'warn' });
       ctx.db.prepare("UPDATE channels SET auto_publish = 1 WHERE platform = 'facebook'").run();
       expect(byName(ctx, 'channel.literature-facebook.account_ref')).toMatchObject({ status: 'fail' });
     });

     it('fails when two channels on one platform resolve to the same account, naming variables but not values', () => {
       const root = mkdtempSync(join(tmpdir(), 'lantern-doctor-root-'));
       cpSync(join(ROOT, 'config'), join(root, 'config'), { recursive: true });
       writeFileSync(
         join(root, 'config', 'channels', 'literature-facebook-mirror.yaml'),
         'vertical: literature\nplatform: facebook\naccount_ref: FB_PAGE_ID_MIRROR\nformats: [square]\ncadence:\n  posts_per_day: 1\n  times: ["10:00"]\ncaption:\n  text_max: 2000\n',
       );
       const db = testDb();
       syncConfig(db, loadConfig(root));
       const base = healthyCtx({ db, root });

       const same = byName({ ...base, env: { ...ENV, FB_PAGE_ID_COMMONPLACE: '9876543', FB_PAGE_ID_MIRROR: '9876543' } }, 'channels.destinations');
       expect(same).toMatchObject({ status: 'fail' });
       expect(same?.detail).toContain('literature-facebook-mirror');
       expect(same?.detail).toContain('FB_PAGE_ID_MIRROR');
       expect(same?.detail).not.toContain('9876543');

       expect(byName({ ...base, env: { ...ENV, FB_PAGE_ID_MIRROR: '5555555' } }, 'channels.destinations')).toMatchObject({
         status: 'ok',
       });
     });

     it('warns when LANTERN_CONTACT is not set, and never prints the contact itself', () => {
       const { LANTERN_CONTACT: _contact, ...withoutContact } = ENV;
       expect(byName(healthyCtx({ env: withoutContact }), 'env.contact')).toMatchObject({ status: 'warn' });
       const ok = byName(healthyCtx(), 'env.contact');
       expect(ok).toMatchObject({ status: 'ok' });
       expect(ok?.detail).not.toContain('test@example.invalid');
     });
   ```

   The file already imports `cpSync`, `mkdtempSync`, `writeFileSync`, `join`, `tmpdir`, `loadConfig`, `syncConfig` and `testDb`. Add any that are missing.

3. In `tests/cli.test.ts`, inside the `lantern()` helper's `env` object, add `LANTERN_CONTACT: 'test@example.invalid',` after `YT_CHANNEL_ID_LOOK_CLOSER: 'x',`. This is a fixture update. The existing test `'doctor fails on a fresh database, then passes after migrate'` expects `0 failed, 0 warnings`, and the spawned CLI must not warn about a missing contact.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/doctor/checks.test.ts`

Expected RED:
- **Live-credential test:** fails, because the live channel still warns.
- **Destinations test:** fails, because there is no `channels.destinations` check.
- **Contact test:** fails, because there is no `env.contact` check.
- **Healthy test:** still passes. Record this.

- [ ] **Step 3: Implement**

In `src/doctor/checks.ts`:

1. In `channelChecks`, replace this block:

   ```ts
     out.push(
       env[channel.account_ref]
         ? result(`${prefix}.account_ref`, 'ok', `${channel.account_ref} is set`)
         : result(`${prefix}.account_ref`, 'warn', `${channel.account_ref} is not set in the environment`),
     );

     const row = db.prepare('SELECT enabled, auto_publish FROM channels WHERE id = ?').get(id) as {
       enabled: number;
       auto_publish: number;
     };
     const live = row.enabled === 1 && row.auto_publish === 1;
   ```

   with:

   ```ts
     const row = db.prepare('SELECT enabled, auto_publish FROM channels WHERE id = ?').get(id) as {
       enabled: number;
       auto_publish: number;
     };
     const live = row.enabled === 1 && row.auto_publish === 1;

     out.push(
       env[channel.account_ref]?.trim()
         ? result(`${prefix}.account_ref`, 'ok', `${channel.account_ref} is set`)
         : live
           ? result(`${prefix}.account_ref`, 'fail', `${channel.account_ref} is not set in the environment; a live channel cannot publish without it`)
           : result(`${prefix}.account_ref`, 'warn', `${channel.account_ref} is not set in the environment`),
     );
   ```

2. In `runChecks`, directly after the line `for (const [channel, id] of ids) out.push(...channelChecks(ctx, channel, id));`, still inside the same `if` block, add:

   ```ts
       const byDestination = new Map<string, LoadedChannel[]>();
       for (const channel of ids.keys()) {
         const value = ctx.env[channel.account_ref]?.trim();
         if (!value) continue;
         const key = `${channel.platform}\n${value}`;
         byDestination.set(key, [...(byDestination.get(key) ?? []), channel]);
       }
       const shared = [...byDestination.values()].filter((group) => group.length > 1);
       out.push(
         shared.length === 0
           ? result('channels.destinations', 'ok', 'every enabled channel points at a distinct account')
           : result(
               'channels.destinations',
               'fail',
               shared
                 .map((group) => `${group[0]!.platform}: ${group.map((c) => `${c.slug} (${c.account_ref})`).join(', ')} resolve to the same account`)
                 .join('; '),
             ),
       );
   ```

3. Directly before the `const free = (ctx.freeBytes ?? defaultFreeBytes)(ctx.root);` line, add:

   ```ts
     out.push(
       ctx.env.LANTERN_CONTACT?.trim()
         ? result('env.contact', 'ok', 'LANTERN_CONTACT is set')
         : result('env.contact', 'warn', 'LANTERN_CONTACT is not set; source APIs such as Wikimedia need a contact in the User-Agent'),
     );
   ```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/doctor/checks.test.ts tests/cli.test.ts && npm test && npm run typecheck`

Expected:
- The 3 new doctor tests pass.
- The healthy-system test and all CLI tests pass.
- The full suite has **368** tests.
- Typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/doctor/checks.ts tests/doctor/checks.test.ts tests/cli.test.ts
git commit -m "feat(doctor): fail a live channel without credentials and channels sharing an account; warn when LANTERN_CONTACT is unset

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'
```

Expected: `2`.

---

### Task G4: `onRetry` hook and `DownloadStatusError.finalUrl`

**Files:**
- Modify: `src/lib/http.ts`, `src/lib/download.ts`
- Test: `tests/lib/http.test.ts`, `tests/lib/download.test.ts`

**Interfaces:**
- Consumes: the existing `resolveHttpOptions`, `ResolvedHttpOptions` and `retryDelayMs`.
- Produces:
  - `export interface RetryEvent { url: string; attempt: number; delayMs: number; reason: string }`
  - `HttpOptions.onRetry?: (event: RetryEvent) => void`
  - `ResolvedHttpOptions.onRetry`, which defaults to a no-op
  - `export function errorReason(err: unknown): string`
  - `DownloadStatusError` gains `readonly finalUrl?: string`, the last constructor parameter

  Both `fetchWithRetry` and `downloadWithRetry` call `onRetry` exactly once before each wait between attempts, and never after the final attempt. `reason` is `HTTP <status>` for a retryable status and the error message for a thrown error.

**Why:**
- **Unattended retry visibility.** A request can wait up to about 330 s, and a download up to about 1290 s, silently. Spec §4 says "a cron job leaves a log". This hook is how a stage will log each wait. The wiring to the logger comes with the first scheduled stage (2.3/Phase 5).
- **`DownloadStatusError.finalUrl`.** Parked from the prerequisites final review. When a redirect to another host ends in a 403 or 404, 2.5 needs to know where it landed so it can re-check the license source.

- [ ] **Step 1: Write the failing tests**

In `tests/lib/http.test.ts`:

1. Add `type RetryEvent,` to the import list from `'../../src/lib/http.js'`.
2. Add this block after the closing `});` of `describe('fetchWithRetry with a non-idempotent method', ...)`:

   ```ts
   describe('fetchWithRetry onRetry', () => {
     it('reports a retryable status before waiting', async () => {
       const srv = await scriptedServer([{ status: 503 }, { status: 200 }]);
       const events: RetryEvent[] = [];
       const { sleep } = recordingSleep();
       await fetchWithRetry({ url: srv.base }, { userAgent: UA, sleep, onRetry: (e) => events.push(e) });
       expect(events).toEqual([{ url: srv.base, attempt: 1, delayMs: 500, reason: 'HTTP 503' }]);
     });

     it('reports a network failure before waiting, and nothing after the last attempt', async () => {
       const fetchImpl = (async () => {
         throw new Error('socket hang up');
       }) as unknown as typeof fetch;
       const events: RetryEvent[] = [];
       const { sleep } = recordingSleep();
       await fetchWithRetry(
         { url: 'http://127.0.0.1:1/' },
         { userAgent: UA, sleep, fetchImpl, maxAttempts: 2, onRetry: (e) => events.push(e) },
       ).catch(() => {});
       expect(events).toEqual([{ url: 'http://127.0.0.1:1/', attempt: 1, delayMs: 500, reason: 'socket hang up' }]);
     });
   });
   ```

In `tests/lib/download.test.ts`:

1. Change the http import to `import { HttpError, type RetryEvent } from '../../src/lib/http.js';`.
2. Add these tests at the end of `describe('downloadWithRetry', ...)`:

   ```ts
     it('reports a retry through onRetry', async () => {
       const srv = await serve((_req, res, n) => {
         if (n === 1) {
           res.writeHead(503);
           res.end();
           return;
         }
         res.writeHead(200, { 'content-type': 'image/png' });
         res.end(PAYLOAD);
       });
       const events: RetryEvent[] = [];
       const { sleep } = recordingSleep();
       await downloadWithRetry(`${srv.base}/x.png`, join(dir, 'x.png'), { userAgent: UA, sleep, onRetry: (e) => events.push(e) });
       expect(events).toEqual([{ url: `${srv.base}/x.png`, attempt: 1, delayMs: 500, reason: 'HTTP 503' }]);
     });

     it('reports where a redirected download ended when it fails', async () => {
       const srv = await serve((req, res) => {
         if (req.url === '/old.jpg') {
           res.writeHead(302, { location: '/gone.jpg' });
           res.end();
           return;
         }
         res.writeHead(404);
         res.end();
       });
       const err = await downloadWithRetry(`${srv.base}/old.jpg`, join(dir, 'gone.jpg'), { userAgent: UA }).catch((e: unknown) => e);
       expect(err).toBeInstanceOf(DownloadStatusError);
       expect(err).toMatchObject({ status: 404, finalUrl: `${srv.base}/gone.jpg` });
     });
   ```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/http.test.ts tests/lib/download.test.ts && npm run typecheck`

Expected RED:
- **Typecheck** fails, because `onRetry` and `RetryEvent` do not exist.
- **The three `onRetry` tests** fail with `events` equal to `[]`.
- **The `finalUrl` test** fails, because `finalUrl` is undefined.

- [ ] **Step 3: Implement**

In `src/lib/http.ts`:

1. Directly after the `HttpResult` interface, add:

   ```ts
   export interface RetryEvent {
     url: string;
     /** The attempt that just failed, 1-based. */
     attempt: number;
     delayMs: number;
     /** `HTTP <status>` for a retryable status, otherwise the error message. */
     reason: string;
   }
   ```

2. In `HttpOptions`, directly after `retryUnsafe` and its doc comment, add:

   ```ts
     /** Called before each wait between attempts, so an unattended run can log why it is waiting (spec section 4). */
     onRetry?: (event: RetryEvent) => void;
   ```

3. In `ResolvedHttpOptions`, add `onRetry: (event: RetryEvent) => void;` after `now: () => number;`.

4. In `resolveHttpOptions`, add `onRetry: opts.onRetry ?? (() => {}),` after `now: opts.now ?? Date.now,`.

5. Directly after `resolveHttpOptions`, add:

   ```ts
   /** A short, loggable description of a thrown value. */
   export function errorReason(err: unknown): string {
     return err instanceof Error ? err.message : String(err);
   }
   ```

6. In `fetchWithRetry`'s `catch` block, replace `if (attempt < o.maxAttempts) await o.sleep(retryDelayMs(attempt, null, { ...delays, nowMs: o.now() }));` with:

   ```ts
         if (attempt < o.maxAttempts) {
           const delayMs = retryDelayMs(attempt, null, { ...delays, nowMs: o.now() });
           o.onRetry({ url: req.url, attempt, delayMs, reason: errorReason(err) });
           await o.sleep(delayMs);
         }
   ```

7. At the end of `fetchWithRetry`'s loop body, replace `await o.sleep(retryDelayMs(attempt, res.headers.get('retry-after'), { ...delays, nowMs: o.now() }));` with:

   ```ts
       const delayMs = retryDelayMs(attempt, res.headers.get('retry-after'), { ...delays, nowMs: o.now() });
       o.onRetry({ url: req.url, attempt, delayMs, reason: `HTTP ${res.status}` });
       await o.sleep(delayMs);
   ```

In `src/lib/download.ts`:

1. Add `errorReason` to the import list from `'./http.js'`.

2. Replace the `DownloadStatusError` class with:

   ```ts
   export class DownloadStatusError extends Error {
     override name = 'DownloadStatusError';

     constructor(
       readonly url: string,
       readonly status: number,
       readonly attempts: number,
       /** Where the request ended after redirects, so the caller can re-check the host it landed on. */
       readonly finalUrl?: string,
     ) {
       super(`download failed with HTTP ${status} after ${attempts} attempt${attempts === 1 ? '' : 's'}: ${url}`);
     }
   }
   ```

3. In `downloadWithRetry`, change `throw new DownloadStatusError(url, res.status, attempt);` to `throw new DownloadStatusError(url, res.status, attempt, res.url || url);`.

4. In the non-2xx block, replace `await o.sleep(retryDelayMs(attempt, retryAfter, { ...delays, nowMs: o.now() }));` with:

   ```ts
           const delayMs = retryDelayMs(attempt, retryAfter, { ...delays, nowMs: o.now() });
           o.onRetry({ url, attempt, delayMs, reason: `HTTP ${res.status}` });
           await o.sleep(delayMs);
   ```

5. In the `catch` block, replace `if (attempt < o.maxAttempts) await o.sleep(retryDelayMs(attempt, null, { ...delays, nowMs: o.now() }));` with:

   ```ts
         if (attempt < o.maxAttempts) {
           const delayMs = retryDelayMs(attempt, null, { ...delays, nowMs: o.now() });
           o.onRetry({ url, attempt, delayMs, reason: errorReason(err) });
           await o.sleep(delayMs);
         }
   ```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/http.test.ts tests/lib/download.test.ts && npm test && npm run typecheck`

Expected:
- All 4 new tests pass, and every existing http and download test passes unchanged.
- The full suite has **372** tests.
- Typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/http.ts src/lib/download.ts tests/lib/http.test.ts tests/lib/download.test.ts
git commit -m "feat(lib): onRetry hook for fetchWithRetry and downloadWithRetry; DownloadStatusError reports finalUrl

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'
```

Expected: `2`.

---

### Task G5: `paths.cache` and `paths.media`

**Files:**
- Modify: `src/lib/paths.ts`
- Test: `tests/lib/paths.test.ts`

**Interfaces:**
- Produces `Paths` with two new fields, `cache: string` and `media: string`.
  - `cache` defaults to `<root>/data/cache` and can be overridden with `LANTERN_CACHE`.
  - `media` defaults to `<root>/data/media` and can be overridden with `LANTERN_MEDIA`.
  - Both resolve the same way as `db` and `logs`: an absolute override is kept as-is, and a relative one resolves against the root.

**Why:**
- The **Novel-sized fixtures** row says "add `paths.cache` to `resolvePaths`".
- Milestone 2.5 needs the media root, because originals go under `data/media/source/`, never under `data/cache/`.
- Both are one-line, config-shaped additions, and they let stages stop hardcoding `data/...` paths.

- [ ] **Step 1: Write the failing tests**

In `tests/lib/paths.test.ts`:

1. In `'defaults everything under the given default root'`, make the expected object:

   ```ts
       expect(resolvePaths({}, defaultRoot)).toEqual({
         root: defaultRoot,
         db: join(defaultRoot, 'data', 'lantern.db'),
         logs: join(defaultRoot, 'logs'),
         migrations: join(defaultRoot, 'migrations'),
         cache: join(defaultRoot, 'data', 'cache'),
         media: join(defaultRoot, 'data', 'media'),
       });
   ```

   This is a sanctioned assertion change. The object gains two fields.

2. Add this test after `'honours overrides, resolving relative ones against LANTERN_ROOT rather than the default root'`:

   ```ts
     it('resolves cache and media overrides the same way as the database and logs', () => {
       const root = resolve('/srv/lantern');
       const media = resolve('/mnt/media');
       const p = resolvePaths({ LANTERN_ROOT: root, LANTERN_CACHE: 'fixtures', LANTERN_MEDIA: media }, resolve('/elsewhere'));
       expect(p.cache).toBe(join(root, 'fixtures'));
       expect(p.media).toBe(media);
     });
   ```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/lib/paths.test.ts`

Expected RED: both tests fail, because `cache` and `media` are missing.

- [ ] **Step 3: Implement**

In `src/lib/paths.ts`:

1. Change the `Paths` interface to:

   ```ts
   export interface Paths { root: string; db: string; logs: string; migrations: string; cache: string; media: string }
   ```

2. In `resolvePaths`, add these two lines after the `migrations` line of the returned object:

   ```ts
       cache: under(env.LANTERN_CACHE ?? 'data/cache'),
       media: under(env.LANTERN_MEDIA ?? 'data/media'),
   ```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/lib/paths.test.ts && npm test && npm run typecheck`

Expected:
- Paths tests pass.
- Full suite: **373** tests across 17 files.
- Typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add src/lib/paths.ts tests/lib/paths.test.ts
git commit -m "feat(lib): resolvePaths exposes cache and media roots

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'
```

Expected: `2`.

---

### Task G6: Docs

**Files:**
- Modify: `claude.md`, `plan.md`

**Interfaces:** none.

**Why:** Spec §15 says a stale CLAUDE.md is worse than none.
- **`claude.md`:** §8 must state the tier 1 host rule and the scholarly author rule, now that the code enforces them.
- **`plan.md`:** it needs status lines for the rows this plan closes, and for the parts it leaves open.

Both files are Markdown and already contain non-ASCII characters. Do not re-encode them. Change only what is listed below.

- [ ] **Step 1: Edit `claude.md` §8**

In §8, find the paragraph that ends with the line `migrations 002-004 as a best-effort backstop for writes that bypass that code.` Append this text to that paragraph, then re-wrap only that one paragraph to about 80 columns:

```
A tier 1 source must also be the URL of its full text on Project Gutenberg,
Standard Ebooks or Wikisource (`PRIMARY_TEXT_DOMAINS`, enforced in TypeScript
only; archive and proxy copies do not count), and scholarly evidence verifies a
quote only when it attributes the quote to the same author.
```

- [ ] **Step 2: Edit `plan.md`**

1. Under `### Prerequisites carried from the Phase 1 final review`, find the existing status line that begins `> **Status:** the **I4** row`. Directly after it, insert a blank line and then this line:

   ```markdown
   > **Status:** the **Missing channel credentials** row is done, and so is the doctor half of **I6** (two enabled channels on one platform that resolve to the same account fail `channels.destinations`), on branch `phase-2-guardrails` (docs/plans/phase-2-guardrails.md, Task G3). The publish-time guard, a channel-rename command and the re-added-channel `auto_publish` decision remain for Phase 4.
   ```

2. Under `### Prerequisites carried from the Part B final review`, find the existing status line that begins `> **Status:** the **Apply takes evidence, not a decision**`. Directly after it, insert a blank line and then this line:

   ```markdown
   > **Status:** the **Tier 1/2 host allowlists** row is done for tier 1 hosts and for scholarly `authorMatches` on branch `phase-2-guardrails` (Tasks G1-G2); a curated scholarly host allowlist remains for 2.2. From **Unattended retry visibility**, the `onRetry` hook and the doctor `LANTERN_CONTACT` check are done (Tasks G3-G4); the run deadline and the retry log line remain for Phase 5. `paths.cache` and `paths.media` exist (Task G5), and `DownloadStatusError` reports `finalUrl` (Task G4).
   ```

- [ ] **Step 3: Verify**

```bash
grep -c 'PRIMARY_TEXT_DOMAINS' claude.md
grep -c 'phase-2-guardrails' plan.md
grep -cP '[^\x00-\x7F]' claude.md plan.md
git diff --stat
```

Expected:
- `PRIMARY_TEXT_DOMAINS` in `claude.md`: `1`.
- `phase-2-guardrails` in `plan.md`: `2`.
- The non-ASCII line counts are unchanged from before the edit. Record both before and after.
- The diff touches only `claude.md` and `plan.md`.

- [ ] **Step 4: Commit**

```bash
git add claude.md plan.md
git commit -m "docs: tier 1 host and scholarly author rules; guardrails prerequisite status

Co-Authored-By: <your model attribution line>
Claude-Session: https://claude.ai/code/session_014ohXdyTGgaZN1ZzuMHq69v"
git log -1 --format=%B | grep -cE '^(Co-Authored-By|Claude-Session):'
```

Expected: `2`.

---

## Done when

- Tasks G1-G6 are committed on `phase-2-guardrails`.
- The full suite passes: **373** tests across 17 files.
- `npm run typecheck` exits 0.
- No new non-ASCII characters appear in `.ts` files.
- No doctor detail prints the value of `LANTERN_CONTACT` or of any `account_ref` variable.
- Nothing under `migrations/` or `data/` has changed.

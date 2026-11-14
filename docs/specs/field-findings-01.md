# Field findings 01: Next.js 16 + Sanity build review

Status: candidate checks. Post-release batch. Nothing here changes the release scope or the open PRs.

Source: a code review of real Next.js 16 + Sanity sites before a new build. Every item is written as a generic pattern. Never add a client, company, person, domain or URL from where it was found.

## How to use this file

1. For each candidate, find the closest existing check id and mark it **covered**, **partly covered** or **new**. Fill the "Maps to" column.
2. Cite Grounded Code for the framework behaviour each check relies on, for the installed versions, in the check's source comment:
   `// [GC] <package>@<version> › <section> — <url>`
   If no doc covers it: `// [GC] no source found`, and flag it in the check-in.
3. **Covered**: add the fixture below to that check's tests if it isn't already there. Do this post-release.
4. **Partly covered**: extend the existing check only if its PR isn't open yet. Write the failing test first.
5. **New**: add a PROGRESS.md row under batch FF and build it after the release PR merges.
6. Every check ships with one failing fixture and one passing fixture. A check that can be unsure reports `unsure`, never `pass`.

Severity: **fix-first** (data leak, silent failure, a site indexed against the owner's wishes) · **fix-soon** · **advice**.
Where: **static** (repo files) · **deployed** (HTTP against a URL) · **both**.

## A. Indexing (a site meant to stay out of search)

| ID    | Pattern                                                                                                                    | Why it matters                                                                                                   | Where             | Severity  | Maps to                                        | Status |
| ----- | -------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------- | --------- | ---------------------------------------------- | ------ |
| FF-01 | `robots.txt` disallows paths whose pages also carry noindex                                                                | Crawlers can't fetch the page, so they never see the noindex, and the URL can still appear in results from links | both              | fix-first | none; nearest `robots-block` and `noindex`     | new    |
| FF-02 | A sitemap is served (or `app/sitemap.ts` exists) while indexing is off                                                     | It actively invites crawling of pages meant to be hidden                                                         | both              | fix-first | `hidden-in-sitemap` (deployed half)            | partly |
| FF-03 | No `X-Robots-Tag: noindex` on routes that metadata doesn't reach (`/studio`, 404, API routes, files) while indexing is off | The meta tag only covers HTML pages that call the metadata function                                              | deployed          | fix-first | none; nearest `hidden-indexable` and `noindex` | new    |
| FF-04 | A page-level `robots` in metadata replaces the layout's noindex                                                            | Next merges metadata shallowly, so one page's setting silently re-enables indexing                               | static            | fix-first | `hidden-indexable` (deployed symptom)          | partly |
| FF-05 | The indexing switch accepts loose values (`1`, `yes`, any non-empty string)                                                | A typo in an env var turns indexing on; only the exact string `true` should                                      | static            | fix-soon  | none                                           | new    |
| FF-06 | The noindex smoke test runs on Preview but not on Production                                                               | Production is where indexing matters                                                                             | static (CI files) | fix-soon  | none                                           | new    |

Fixtures: robots with `Disallow: /` plus page meta noindex (fail) → `Allow: /` with no sitemap line (pass). Layout noindex plus a page with `robots: { index: true }` while the switch is off (fail).

## B. Sanity publish webhook and caching

| ID    | Pattern                                                                     | Why it matters                                                                                                                                           | Where  | Severity  | Maps to                                                             | Status |
| ----- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ | --------- | ------------------------------------------------------------------- | ------ |
| FF-07 | Signature compared with `===` / `!==` instead of a constant-time compare    | Timing leak on the secret                                                                                                                                | static | fix-soon  | none                                                                | new    |
| FF-08 | No age limit on the signed timestamp (and no future limit)                  | A captured request can be replayed indefinitely                                                                                                          | static | fix-soon  | none                                                                | new    |
| FF-09 | A missing webhook secret returns 4xx (or 200)                               | 4xx marks the delivery permanently failed, so publishes stop reaching the site; 200 accepts anyone. A missing secret should return 5xx so Sanity retries | static | fix-first | none                                                                | new    |
| FF-10 | Body read without a size cap, or parsed before the signature check          | Memory abuse; the signature must be checked over the raw body                                                                                            | static | fix-soon  | none                                                                | new    |
| FF-11 | `drafts.` or `versions.` ids clear the cache                                | Wasted purges; draft activity churns the live cache                                                                                                      | static | advice    | none                                                                | new    |
| FF-12 | Time-based `revalidate` mixed with tag-based revalidation on the same reads | Content changes on a timer as well as on publish, and caching is hard to reason about                                                                    | static | fix-soon  | none; nearest `next-stale-after-publish` and `revalidate-too-often` | new    |
| FF-13 | `useCdn: true` on published reads that are cached by tag                    | A read right after a publish can cache the older CDN copy indefinitely                                                                                   | static | fix-first | `next-stale-after-publish` (deployed consequence)                   | partly |
| FF-14 | Webhook logs include the body, document id or secret                        | Leaks content and secrets into logs                                                                                                                      | static | fix-soon  | none                                                                | new    |

Fixtures: a route handler with `if (sig !== expected)` (fail) → `timingSafeEqual` on equal-length buffers plus an age check (pass). Missing env returning `401` (fail) → `500` (pass).

## C. Tokens and server-only code

| ID    | Pattern                                                                    | Why it matters                                                                          | Where    | Severity  | Maps to                           | Status |
| ----- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------- | --------- | --------------------------------- | ------ |
| FF-15 | A module throws at import when the Sanity token is missing                 | Every build, test and CI job then needs a secret; read it lazily on the draft path only | static   | fix-soon  | none                              | new    |
| FF-16 | A Sanity client created at module scope in `next.config`                   | Forces fake env vars into tests and runs network setup at build time                    | static   | advice    | none                              | new    |
| FF-17 | A `'use server'` file exports non-async values                             | Next rejects it, or it exposes things as server actions; use `import 'server-only'`     | static   | fix-soon  | none                              | new    |
| FF-18 | The read token is importable from code on the published path or the client | The token can end up in a client bundle or in published reads                           | static   | fix-first | `secret-in-js` (deployed symptom) | partly |
| FF-19 | Studio responses are cacheable (no `no-store`)                             | Editors can see stale Studio shells                                                     | deployed | advice    | none                              | new    |

## D. Forms and personal data

| ID    | Pattern                                                                                        | Why it matters                                          | Where  | Severity  | Maps to                                                     | Status |
| ----- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------ | --------- | ----------------------------------------------------------- | ------ |
| FF-20 | A failed webhook or email send still shows the visitor a success state                         | Leads are lost silently                                 | static | fix-first | none; nearest `crm-went-quiet`                              | new    |
| FF-21 | Raw email, phone or form values are pushed to `dataLayer` or analytics                         | Personal data reaches third parties                     | static | fix-first | none; nearest `tracker-on-sensitive-page` and `events-fire` | new    |
| FF-22 | Submitted form values are written to logs or error reports                                     | Personal (sometimes health) data sits in logs           | static | fix-first | none                                                        | new    |
| FF-23 | A form POST with no origin check, honeypot or signed token                                     | Spam and cross-site submissions                         | static | fix-soon  | none                                                        | new    |
| FF-24 | A third-party webhook URL is hardcoded in source                                               | A leaked endpoint anyone can post to; it belongs in env | static | fix-first | none; nearest `secret-in-js`                                | new    |
| FF-25 | The form's validation library imported into the client bundle when only field names are needed | Extra download on every form page                       | static | advice    | none                                                        | new    |

Fixtures: `catch { return { ok: true } }` around a send (fail) → the error state returned and rendered (pass). A `dataLayer.push({ email })` call (fail).

## E. Content and GROQ

| ID    | Pattern                                                                                                         | Why it matters                                                                  | Where  | Severity | Maps to                                                                   | Status |
| ----- | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------ | -------- | ------------------------------------------------------------------------- | ------ |
| FF-26 | A GROQ projection of a reference field without `->`                                                             | Links render as empty references; run it with groq-js against a fixture dataset | static | fix-soon | `model-unexpanded` (deployed symptom)                                     | partly |
| FF-27 | A schema section type with no registered component, or a component with no schema                               | The section silently renders nothing, or the code is dead                       | static | fix-soon | none; nearest `model-dependents`                                          | new    |
| FF-28 | An image field with no alt-text validation, or an image block with no asset                                     | Accessibility failure, or a broken image                                        | both   | fix-soon | `images-alt-missing`, `images-alt-empty`, `images-broken` (deployed half) | partly |
| FF-29 | Presentation `resolve` doesn't map a route to its document                                                      | Visual editing shows "Missing a main document"                                  | static | advice   | none                                                                      | new    |
| FF-30 | Stega encoding is not cleaned on URLs, attributes, comparisons and metadata, or is over-cleaned on visible text | Broken links and comparisons, or click-to-edit lost                             | static | fix-soon | `stega-leak` (title, meta tags and JSON-LD only)                          | partly |

## F. Versions, config, tests and licences

| ID    | Pattern                                                                                         | Why it matters                                                                                          | Where  | Severity  | Maps to                               | Status |
| ----- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------ | --------- | ------------------------------------- | ------ |
| FF-31 | `next` below 16.4.1                                                                             | Known fixes missing; confirm the advisory and floor through Grounded Code before shipping the threshold | static | fix-first | none; nearest `library-with-advisory` | new    |
| FF-32 | `zod` below 4.6.6 (GHSA-mrhx-c7xc-m3w5)                                                         | A known advisory; confirm the range against the GHSA before shipping                                    | static | fix-first | none; nearest `library-with-advisory` | new    |
| FF-33 | `tsconfig` `target` of `es5` on a modern Next app                                               | Bigger output and down-levelled code for no reason                                                      | static | advice    | none                                  | new    |
| FF-34 | An accessibility spec asserts violations exist (`> 0`, `toBeGreaterThan(0)`) instead of zero    | The test passes while the site is inaccessible                                                          | static | fix-soon  | none                                  | new    |
| FF-35 | Code from an ISC- or MIT-licensed starter with its licence notice removed                       | Licence breach                                                                                          | static | fix-soon  | none                                  | new    |
| FF-36 | Draft-mode or visual-editing code copied across a next-sanity major version (12 → 13) unchanged | API changes break preview quietly                                                                       | static | advice    | none                                  | new    |

## Report shape for the check-in

```
| FF | Maps to | Status (covered / partly / new) | GC source | Plan |
```

Report times in PT. Don't build any **new** item before the release PR merges.

## Mapping result (13 Nov 2026)

Status is against the checks on `main` when the mapping was written. No item is fully **covered**. Seven are **partly covered**: the deployed symptom exists as a check, and the part that is missing is reading the repository's source (FF-02, FF-04, FF-13, FF-18, FF-26, FF-28, FF-30). The other 29 are **new**. A partly covered item still gets its own FF row for the missing half, because a deployed check cannot read a repository.

Fixtures to add to the existing checks (they exercise the deployed half only, and never block an FF row):

| Check                      | Fixture to add                                                               | For   |
| -------------------------- | ---------------------------------------------------------------------------- | ----- |
| `hidden-in-sitemap`        | `gaugeline.hidden.json` with `{"match":"/*"}` and a sitemap that lists pages | FF-02 |
| `hidden-indexable`         | a hidden `/*` rule and a 200 page with no noindex                            | FF-04 |
| `next-stale-after-publish` | a cached copy older than the document's last change                          | FF-13 |
| `secret-in-js`             | a Sanity token in a served script, built at run time and never a literal     | FF-18 |
| `model-unexpanded`         | a page showing a bare reference id                                           | FF-26 |
| `images-broken`            | an image block whose asset is missing                                        | FF-28 |
| `stega-leak`               | invisible characters inside JSON-LD strings                                  | FF-30 |

## Build order and rules (owner, 13 Nov 2026)

This replaces "Don't build any new item before the release PR merges" above. The new rows are built in severity order: fix-first first, then fix-soon, and advice last if time allows. They are built in groups, one pull request each: the shared source reader (FF-00, a prerequisite that is not in the list above), indexing, webhooks, tokens, forms, versions, then fix-soon.

- **Static checks** read a repository's files through the local source reader (`readLocalSource`), which is a separate input kind from the content adapter and from a page. It only reads: it never follows a link out of the folder, caps what it reads, skips `node_modules` and `.git`, and refuses `.env*` and other secret-looking files without keeping their text. A check never prints a value it finds in a file.
- **A check that can be unsure** reports `unsure` (could-not-check), never `pass`. A folder the reader could not finish never passes a check.
- **Probing checks** (FF-03 and FF-19 ask for the editor studio and API routes, which are non-public paths) are off by default, run only with `--owner-consent` and a config entry, and are documented as "run only on sites you own or have permission to test". FF-23 stays static: Gaugeline never submits a form.
- **Webhook checks (FF-07 to FF-10):** the content platform's own verification helper compares signatures with a plain comparison and applies no age limit, and the framework wrapper returns `null` rather than `false` when no secret is set. A check treats use of the official helper as advice, never as a failure, and says so in the finding.
- **Version checks (FF-31, FF-32)** never enforce a threshold that is not verified. FF-32's range is verified against the published advisory; for the 3.x line, which has no fixed release, the finding says the fix is the major upgrade and does not claim 3.x was tested. FF-31 is verified for the 16 line only: one global floor is wrong for older lines, so it is built per release line, from a data file with a `verified` flag, and it reports `unsure` when only a range (not an installed version) can be read from `package.json`.
- **Sources:** Grounded Code was not connected when the mapping was written. Where a framework behaviour is cited, the check's source comment names the official page it was read from (`// [docs] <package>@<version> > <section> - <url>`); where none was reachable it says `// [GC] no source found (uncited)`, and the pull request lists it as uncited. The check text does not state that behaviour as fact.

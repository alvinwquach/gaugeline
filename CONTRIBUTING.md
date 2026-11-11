# Contributing to Gaugeline

## Set up

You need Node.js 22 or newer and pnpm.

```bash
pnpm install
pnpm build
pnpm test
```

Tests run against invented fixture sites on 127.0.0.1 and recorded API responses. They need no
network and no keys.

## Add a check

Run `pnpm new:check <id> --area <area> --severity <level>`, fill in the four texts (what it catches,
why it matters, how to fix it, the technical line) and the rule, then run `pnpm gen:checks` to
regenerate the checks reference. The whole walkthrough is in
[docs/contributing/adding-a-check.md](docs/contributing/adding-a-check.md).

## Add a fixture

A fixture is a folder under `packages/fixtures/sites/` with static files and an optional
`routes.json` (see "Adding a fixture site" below). One fixture per behaviour. Never point a test at a
real site.

## Writing an adapter

An adapter puts one content system (a CMS) behind `ContentAdapter` (`packages/core/src/adapters/types.ts`),
so every check that compares "what the CMS says is published" with "what the page shows" works on it.
Sanity (`adapters/sanity.ts`) is the worked example. The rules are the same for every platform:

- **Read only.** Every request is a GET or HEAD (or a GraphQL query, never a mutation) through the
  fetcher you are given. Start your docs page by listing, with links, the platform's documented read
  endpoints and how to make its narrowest key. If the platform has no read-only key, say so in the first
  paragraph and recommend the narrowest option (a dedicated low-role user, a scoped key).
- **Fingerprints, never content.** Return ids, types, slugs or addresses, times, counts and a hash of
  each field the settings name (`hashValue`). A field's value is read only to be hashed. With no fields
  named, ask for none. Reports show field names and the mismatch, never the client's words.
- **The key** comes from the environment, travels in a header and never in an address, and is blanked
  from every message (`createRedactor`). Say which `keyKind` it is: `read-only`, `scoped` or `full-access`.
  An adapter that reads only what the site shows every visitor (`adapters/sitemap-feed.ts`) asks for no
  key: it is `read-only` with `noKey: true`, and the contract entry leaves `key` out, so the suite checks
  that no request carries an `Authorization` header or a cookie.
- **No fields?** A platform that has none (a sitemap) answers `fieldCounts()` with `AdapterCouldNotCheck`
  whose reason starts "Not applicable", leaves every `fieldHashes` empty, and returns `"not-applicable"`
  from `draftsReachable()` without asking anything. The contract entry leaves `expected.fields` out.
- **No date?** `PublishedDoc.updatedAt` is optional for the same reason: when the platform does not say,
  leave it out. Never make a date up.
- **Could not check, with the reason.** Anything the platform does not expose, or a key that may not
  read it, throws `AdapterCouldNotCheck`. Never scrape an admin screen and never report a pass.
- **Rate limits.** Wait once for a short Retry-After, then throw `AdapterRateLimitedError` carrying what
  was read, so the run reports a partial result.

To add one, in this order:

1. Write the adapter in `packages/core/src/adapters/<cms>.ts`, and add it to `BUILT_ADAPTERS` in
   `registry.ts` (and take it out of `PLANNED_ADAPTERS`).
2. Add a recorded-response fixture (invented content, no real client data; the Sanity one is
   `adapters/__tests__/sanity-fixture.ts`) and one `ContractEntry` for it in
   `adapters/__tests__/entries.ts`. The contract suite (`contract.test.ts`, one `describe.each` over
   every entry) then runs against it with no test of yours needed for these rules: counts and
   fingerprints but never a value, a missing field counts 0, no request but GET or HEAD, a key that is
   refused is could-not-check, a rate limit is waited out once and then reported as partial.
3. Write `docs/integrations/<cms>.md` with a freelancer example, change the row in
   `docs/integrations/index.md` from planned to built (a test keeps the table and the registry in step),
   and add a changeset.

## Add a connector

Connectors read counts and shapes from another system, never content. Keys come from environment
variables and are never printed or stored. The connector interface arrives with the first connector
branch; this section links to it then. Not yet.

## Docs first, changesets and the PR gate

- Write the docs page and the `--help` text first, with the intended output
  ([docs/contributing/docs-first.md](docs/contributing/docs-first.md)); tests then assert that output,
  and examples in the docs run in CI ([docs/contributing/docs-examples.md](docs/contributing/docs-examples.md)).
- Add a changeset with `pnpm changeset` (see "Add a changeset" below).
- If the PR gate fails, see "Why did pr-gate fail?" below.

## Docs requirements for every release

Tests enforce these, so a pull request cannot skip them. The details are in
[docs/contributing/migration-guides.md](docs/contributing/migration-guides.md).

- **Since badges.** Every check page shows "Since vX". A new check needs nothing beyond its
  changeset: until a release stamps it, the page shows the next version from the pending changesets.
  `pnpm version` writes the real one to `docs/check-since.lock.json`, and a released entry never changes.
- **Migration guides.** A major bump, or a changeset line starting `BREAKING:`, needs a
  `Migration: <slug>` line and a page at `docs/migrations/<slug>.md`. A test fails without it.
- **The feed.** `pnpm docs:changelog` also writes `docs/public/changelog.atom`; CI runs it with
  `--check`, so commit what it writes.
- **A freelancer example in every new docs page.** One invented client from the kind of work Gaugeline
  is for (a clinic's pinned Node version, a bar's ordering page, a pop-up shop's price list), with the
  real output.

## The three rules a pull request cannot break

1. **Read-only.** Requests to a checked site are `GET` or `HEAD`, through the fetcher only.
   ([ADR-0001](docs/adr/0001-read-only-by-construction.md))
2. **Plain rules.** No check calls a model; the same input gives the same findings.
   ([ADR-0002](docs/adr/0002-plain-rules-no-model-calls.md))
3. **Nothing sent.** No request to any host the user did not name or configure: no telemetry, no
   update check. ([ADR-0003](docs/adr/0003-no-telemetry-nothing-sent.md))

What may change between versions and what may not is in [STABILITY.md](STABILITY.md#semver-rules).
Security problems go through [SECURITY.md](SECURITY.md), and everyone follows the
[Code of Conduct](CODE_OF_CONDUCT.md).

## Layout

- `packages/core` is the check engine. It never imports the CLI and never calls `process.exit`.
- `packages/cli` is the `gaugeline` command. It parses arguments, calls core and picks the exit code.
- `packages/app-server` is the local server behind `gaugeline open`. Bundled into the CLI.
- `packages/app` is the browser client (Vite, React, TypeScript). Its build is embedded in the CLI package.

## The app: how it is built and embedded

`gaugeline open` serves a web app from the `gaugeline` package itself, so `npx gaugeline open` needs
no second download. The pieces:

1. `packages/app` builds with Vite to `packages/app/dist`: hashed file names (`assets/index-<hash>.js`),
   relative base, no source maps.
2. `pnpm build` builds the app first, then core and the CLI (tsup empties `packages/cli/dist`), and
   last runs `scripts/embed-client.mjs`. It copies the app's build to `packages/cli/dist/client`
   and writes `client-manifest.json` there: `[{ path, type, bytes, gzipBytes, sha256 }]`, sorted by path.
   Building only the CLI (`pnpm --filter gaugeline build`) leaves no client, and `gaugeline open` then
   says "the app was not built into this package" and exits 2. Run `pnpm build`.
3. At start, `packages/app-server/src/static.ts` reads every file in the manifest into a `Map` keyed by
   URL path, checks each against its `sha256`, and refuses to start if one differs. A request is
   answered by `map.get(pathname)`: a request path is never joined to a folder. `/` is never cached;
   hashed files are cached for a year; the `sha256` is the ETag.
4. Every response carries a strict Content-Security-Policy (no inline script, no inline style, no
   eval, nothing from another origin), `X-Content-Type-Options`, `Referrer-Policy` and
   `Cross-Origin-Resource-Policy`. The client must work under it: use classes, not `style=`.

### Adding a view

The navigation renders from the `VIEWS` list in `packages/app/src/views.ts`: add one entry
(`{ id, label, component }`) and a component in `packages/app/src/views/`. The shell does not change.
A view reads the run it is given (`RunState`, from `store.ts`) and draws every value from a checked
page as a text child, never as HTML. Component tests run with Vitest and Testing Library
(`// @vitest-environment jsdom` at the top of the file); the browser tests are in `e2e/`.
`packages/app/src/check-titles.ts` (check titles, each check's plain-English text and the sample nouns, so the app can
name what passed and explain a finding from the result's ids alone) is generated by `pnpm gen:checks`, which `--check` keeps in step.

### Reading the size report

`pnpm build` ends with a report, and `node scripts/embed-client.mjs --check` prints it again for what
is already embedded (and fails if a file differs from the manifest):

```text
file                          bytes      gzip
assets/index-DbjD4VMN.js     219779     67832
index.html                      448       284
assets/style-BZk3Igmj.css       305       205
total gzip 66.7 KB of 300.0 KB (no single file over 200.0 KB)
```

Sizes are gzipped, level 9. The budget is 300 KB for the whole client and 200 KB for any one file;
over it the script exits 1 and prints the three largest files. The budget exists to keep the cost of
shipping the app to people who only use the terminal visible. To bring a build back under it, look
at the largest file first: a new dependency is usually why. A new library for the app is a
"Dependency notes" line in the pull request, pinned exactly, and a `devDependency` of
`packages/app` (the CLI keeps no runtime dependency). Anything the client bundles that has its own
licence goes into `packages/cli/THIRD_PARTY_LICENSES.md`.

## Branches and pull requests

1. One change, one branch, one pull request. Branch names are `phase/description`,
   for example `01/scaffold-workspace`.
2. Keep a pull request under about 400 changed lines. Split it if it grows past that.
3. Every pull request description has three sections:
   - **Sources**: for each decision, the document title, its URL and the line that supports it.
     A decision with no source is marked _uncited_.
   - **Architecture notes**: what was chosen, what it was chosen over, and what it costs.
   - **Tests**: what was added, and the counts.
4. Write the tests first: unit, integration, end-to-end, then edge cases.
   A change is done when they pass on Node 22 and 24 in CI.
5. A user-facing change ships its docs page and a changeset file in the same pull request.

## Exit codes

| Code | Meaning                                                                |
| ---- | ---------------------------------------------------------------------- |
| 0    | The check ran                                                          |
| 1    | `--ci` was set and a fix-first finding was found                       |
| 2    | Gaugeline could not run (bad arguments, the site could not be reached) |

## Lint and the core boundary

`pnpm lint` runs ESLint (flat config, type-aware for `packages/*/src`) and `pnpm format:check`
runs Prettier. A pre-commit hook runs both on staged files through lint-staged.

`packages/core` is called by the CLI, the local app, the MCP server and a Sanity Function, so it
must not print, exit or reach into the CLI. Two locks enforce that:

- **Lint** (`eslint.config.js`): in `packages/core/src`, `no-console`, `no-restricted-imports`
  (the CLI package, `exit`/`abort`/`kill`/`exitCode` from `process`),
  `no-restricted-properties` (`process.exit`, `abort`, `kill`) and `no-restricted-syntax`
  (assigning `process.exitCode`).
- **Test** (`packages/core/src/__tests__/boundary.test.ts`): parses every core source file with the
  TypeScript compiler API and fails with the file and line of any import that leaves the package,
  names the CLI, or calls `process.exit`. Relative paths are only resolved here, not in lint. It catches dynamic `import()` and `import type`, and runs
  in CI even if a commit skipped the hook. Reuse `findBoundaryViolations(srcDir)` for later packages.

## Comparing addresses and text

Never hand-roll "is this the same address" or "is this the same text" in a check. Use
`packages/core/src/normalise.ts`:

- `normaliseUrl(input, base?)`: lowercase scheme and host, no default port, no fragment; query and
  trailing slash kept.
- `compareAddresses(a, b, { www, trailingSlash, query })`: says _why_ two addresses differ
  (`scheme`, `www`, `host`, `port`, `path-case`, `trailing-slash`, `path`, `query`). State `www`
  explicitly when it matters: a canonical on `www.` is a different address; a same-site link is not.
- `normaliseText` / `sameText`: curly quotes, dashes, odd spaces and zero-width characters do not
  make two strings different.

The behaviour is pinned by `packages/core/src/__tests__/corpus/normalise.corpus.ts`. The corpus is
**append only**: add new cases at the end of a table; never edit or delete one. If a change makes an
old row fail, the change is wrong or needs a decision in its pull request.

Write invisible characters in source as `\u` escapes (`" "`), never as the raw character.

## Adding a fixture site

Integration and end-to-end tests run against invented sites served from
`packages/fixtures/sites/<name>/` on 127.0.0.1, never against the internet.

1. Make a folder under `packages/fixtures/sites/`. Every name, address, price and sentence in it is
   invented; no real client content goes in the repository.
2. Add static files. `/` serves `index.html`; `/menu` serves `menu.html` or `menu/index.html`.
   Canonicals and links can be relative, since the port changes on every run.
3. Optional `routes.json`, keyed by path, for what a static file cannot say:
   `{ "/": { "status": 301, "location": "/home", "headers": { "x-robots-tag": "noindex" }, "delayMs": 50 } }`.
   `"hang": true` accepts the request and never answers; `"bodyBytes": N` answers with N bytes of HTML.
4. Optional `fixture.json` with `{ "hosts": ["shop.test", "www.shop.test"] }` serves the same files on
   one port per host. Pass `site.hosts` to `createFetcher({ hosts })`.
5. In a test: `await withFixture("name", async (site) => { ... })`. `site.hits` counts requests per
   path, and `site.maxConcurrent` / `site.total` let a test assert the request budget.

Fixture servers listen on 127.0.0.1, which the fetcher refuses by default: use
`createFetcher({ allowPrivate: true })`, or the `hosts` mapping.

## Recording a cassette

Connector tests replay recorded, scrubbed API responses from `packages/testkit/cassettes/` and never
reach a real provider in CI.

```ts
import { createFetcher } from "@gaugeline/core";
import { useCassette } from "@gaugeline/testkit";

const fetcher = createFetcher({ transport: useCassette("stripe-prices") });
```

To record, on your own machine only (recording refuses to run when `CI` is set):

```bash
GAUGELINE_RECORD=1 pnpm vitest run path/to/the.test.ts
```

Use read-only keys, from environment variables, never in code:

| Provider | Key to record with                                                                         |
| -------- | ------------------------------------------------------------------------------------------ |
| Stripe   | A restricted key (`rk_test_...`) with read access only. Secret keys (`sk_...`) are refused |
| Sanity   | A token with the Viewer role                                                               |
| Printful | A private token with read scopes only                                                      |

Before committing, read the diff of the cassette. Request headers are never stored; only
`content-type` and pagination headers are kept from responses; secret-looking query parameters,
key-shaped strings and email addresses are replaced. `cassettes-clean.test.ts` scans every cassette
on every CI run as a second lock. A key that reaches git history must be rotated.

## Add a changeset

Every pull request that changes `packages/*/src` adds a changeset:

```bash
pnpm changeset          # pick gaugeline, choose patch or minor, write one sentence
pnpm changeset --empty  # internal work: write a sentence starting "(internal)"
```

Write the sentence for the person who runs the tool: present tense, one sentence, no file names.
"Checks the 301 map against the plan." not "Add legacy.ts". A summary starting `Headline:` sets the
release's headline on the changelog page. The Release pull request collects these files into
`packages/cli/CHANGELOG.md`; `pnpm docs:changelog` turns that into `docs/changelog.data.json` and
`docs/changelog.md`.

## Why did pr-gate fail?

The `PR gate` workflow checks every pull request against three rules. The fixes:

1. **"This changes source but has no changeset."** Run `pnpm changeset` (or `pnpm changeset --empty`
   for internal work, with a summary starting "(internal)") and commit the file.
2. **"This changes what users see but no docs page changed."** A patch or minor changeset needs the
   matching docs page updated in the same pull request (`docs/changelog.*` is generated and does
   not count). If users really will not notice, make the changeset empty and "(internal)".
3. **"…the summary must be one full sentence…"** Write at least 12 characters ending with a full stop.

A pull request that touches nothing users would notice (a lockfile bump, CI config) can carry the
`internal` label, which skips the gate entirely.

# Contributing to Gaugeline

## Layout

- `packages/core` is the check engine. It never imports the CLI and never calls `process.exit`.
- `packages/cli` is the `gaugeline` command. It parses arguments, calls core and picks the exit code.

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
   A change is done when they pass on Node 18.17, 20 and 22 in CI.
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

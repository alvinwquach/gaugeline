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

- **Read only.** Every request is a GET or HEAD (or a POST for a documented read-only query, below;
  a GraphQL query, never a mutation) through the
  fetcher you are given. Start your docs page by listing, with links, the platform's documented read
  endpoints and how to make its narrowest key. If the platform has no read-only key, say so in the first
  paragraph and recommend the narrowest option (a dedicated low-role user, a scoped key).
- **POST for a documented read-only query.** Some platforms answer a read only to a POST (Wix Data
  `POST /wix-data/v2/items/query`, a GraphQL API that takes no GET). The only way to send one is
  `fetcher.query(url, { allow, body })` ([ADR-0006](docs/adr/0006-read-only-post-queries.md)).
  Write the entry in your adapter's own file with `registerQueryAllow` and export what it returns;
  `fetcher.query` takes the entry's id, and an id nobody registered is refused. Put the same exported
  entry in your `ContractEntry.queryAllow`, in `adapters/__tests__/<id>.contract.ts`. The host is the vendor's (or `{ configured }` for a host
  the person set, passed with each request); the rest comes from the vendor's documentation, which
  the entry links with the date you read it (`checked: null` marks an entry you did not verify):

  ```ts
  export const WIX_ITEMS_QUERY = registerQueryAllow({
    id: "wix-data-query",
    method: "POST",
    host: "www.wixapis.com",
    path: "/wix-data/v2/items/query",
    body: {
      kind: "json-query",
      keys: ["dataCollectionId", "query", "returnTotalCount"],
      operators: ["$eq", "$and", "$hasSome"],
    },
    docs: { url: "https://dev.wix.com/docs/rest/...", checked: "2026-11-11" },
  });

  await fetcher.query("https://www.wixapis.com/wix-data/v2/items/query", {
    allow: WIX_ITEMS_QUERY.id,
    body: { dataCollectionId: "Menu", query: { paging: { limit: 50 } } },
    headers: { authorization: token },
  });
  ```

  A body is a query or it is refused: one GraphQL `query` (no `mutation`, no `subscription`, one
  operation, no stored-query id beside it), or a JSON object of the listed keys and operators, none
  named like a write at any depth. A redirect is never
  followed and a key goes to the entry's host only. The contract suite fails the adapter on a POST that
  matches no entry, a body that is not a query, and any PUT, PATCH or DELETE. Only an adapter's file
  (`packages/core/src/adapters/<cms>.ts`) may register an entry or call `fetcher.query`; a scan fails
  any other file. Do not add a file to the list in `packages/core/src/__tests__/post-boundary.test.ts`.

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

**The quickest way is the generator.** Run it, fill in what it marks, and you are done: there is nothing else to edit.

```bash
pnpm new:adapter <id> [--name "<Name>"] [--read rest|graphql|live-site] [--key read-only|scoped|full-access|none]
```

`--read` and `--key` pick the shape the scaffold starts from, so the rules above are already in the code:

| You pass                                                  | You get                                                                                                                                                                                                                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--read rest` (the default) `--key read-only` or `scoped` | An adapter with a key from `<ID>_TOKEN`, redaction, an address built from one origin so the key never goes elsewhere, pages read until the total, a page that is too big halved, and a rate limit waited out once (copied from the WordPress and Webflow adapters). |
| `--read graphql`                                          | The same, with queries sent as GET parameters and a guard that refuses a document that is not a query.                                                                                                                                                              |
| `--read rest` or `graphql` `--key none`                   | The same for a public API: no key, no `Authorization` header, `draftsReachable()` is `"not-applicable"`.                                                                                                                                                            |
| `--read live-site` (`--key none`)                         | For a platform with no read API: the live site's sitemap through the sitemap and feed reader, fields and drafts answered "not applicable", and a reason in plain words for what is not read (`adapters/framer.ts` is the model).                                    |
| `--key full-access`                                       | For a platform whose only key can also write. This means `--read live-site`: the scaffold does not ask for that key, and `--read rest` with it is refused (release plan in PROGRESS.md, Standing orders).                                                           |

It writes **new files only**: `adapters/<id>.ts`, the entry file `adapters/<id>.entry.ts` (metadata, the loader,
the settings rules and the docs row), `adapters/__tests__/<id>-fixture.ts` (a recorded-response fixture of an
invented site), `<id>.contract.ts`, its own small test, a docs example and docs test, `docs/integrations/<id>.md`
and a changeset. Then it runs what `pnpm gen:adapters` runs, so the new adapter is in the generated index, the
docs table and the sidebar with no hand edit. If a planned entry for the id exists (`strapi.entry.ts` with
`status: "planned"`), the generator replaces that one file with the built entry and keeps its name. It never
touches `registry.ts`, `adapters/index.ts`, `entries.ts`, the docs index, `docs/nav.ts` or `PROGRESS.md`.

The contract suite (`contract.test.ts`, one `describe.each` over every entry) then runs against the new adapter
with no test of yours needed for its rules (counts and fingerprints but never a value, a missing field counts 0,
no request but GET or HEAD, a key that is refused is could-not-check, a rate limit is waited out once and then
reported as partial).

Then make it real, in this order:

1. Read the platform's documentation and fill in every `TODO(new:adapter)` (`grep -rn "TODO(new:adapter" .`).
   They are in the adapter (its endpoints, the key's permissions, the mapping of an item), the entry (the docs
   row), the fixture (change the answers to the shape of the platform's documented responses; keep every value
   invented), the docs page and the changeset. Put the date you read the documentation on the docs page and
   mark a detail you could not confirm `uncited`. The scaffold passes the contract suite with the markers in
   place, so you can build step by step; `no-todo.test.ts` fails until the last one is gone, which is what keeps
   unfinished text out of the docs, the changelog and the run header.
2. Run `pnpm exec tsx packages/core/src/adapters/__tests__/<id>-docs-example.ts`, paste its output into the
   page's `Output` block, and make the settings block match `<ID>_SETTINGS`. The docs test compares them.
3. Add a test in `<id>-adapter.test.ts` for each thing this platform does that no other does. Do not repeat the
   contract. After you change an entry file, run `pnpm gen:adapters` again (CI runs `--check`).
4. A new environment variable changes the public surface: run `pnpm surface`.
5. A check that is particular to the platform (WordPress and Webflow have two each) is a separate step:
   `pnpm new:check`, then register it with the platform's other checks.

POST is for a documented read-only query endpoint only, and only through the allowlist in ADR-0006
(branch `adr/read-only-post`, not merged yet). Until it has merged the scaffold sends GET and HEAD and
nothing else; it marks, in the adapter, where the `queryAllow` entry (method, path pattern, body shape) goes.
Do not add a POST of your own, and do not invent a `query` method on the fetcher.

By hand, the steps are the same files. **Adding an adapter adds files and edits no shared one** (no
`registry.ts`, no `config.ts`, no `adapters/index.ts`, no `entries.ts`, no `docs/integrations/index.md` row, no
`docs/nav.ts` entry, no `PROGRESS.md`): that is what kept six adapter pull requests conflicting.

The steps, if you write the files yourself:

1. Write the adapter in `packages/core/src/adapters/<id>.ts` (more files may start with `<id>`, such as
   `<id>-read.ts`). It exports `create<Cms>Adapter(options)` and nothing else needs to leave the folder.
2. Write its **entry file**, `packages/core/src/adapters/<id>.entry.ts`, the only thing the rest of Gaugeline
   knows about it without loading it. It exports `entries: readonly AdapterEntry[]` (the type is in
   `adapters/entry.ts`; `sanity.entry.ts` and `wordpress.entry.ts` are worked examples, and a planned adapter such
   as `strapi.entry.ts` is the same file with `status: "planned"` and a `branch`, which you replace):
   - `id` (lower case, digits, hyphens: the name in `gaugeline.adapters.json`), `name` (as a person writes it),
     `status: "built"`;
   - `describe`: the `AdapterDescription` (name, `docsUrl`, `keyKind`, `noKey`, `beta`). Export it as
     `<CMS>_DESCRIPTION` from this file: the adapter module imports it from here and returns it from `describe()`,
     so the run header and the adapter say one thing (a test compares them);
   - `envVars`: the variables the adapter may read, when a caller must copy them before loading it;
   - `detect` (optional): how `gaugeline init` recognises the platform from a page, as plain data: the generator tag, hosts
     and path fragments its files come from, response headers (`AdapterDetection` in `entry.ts`). Without it the platform is
     never suggested;
   - `settings`: what it adds to the `gaugeline.adapters.json` rules: `pageReader: true` if it reads the live site's
     sitemap and takes `site`, `sitemaps` and `feeds`; `hyphenFields: true` if its field names have hyphens;
   - `docs`: the row in `docs/integrations/index.md`: `key` (what key it asks for) and `reads` (what it reads,
     one line of Markdown), and `page`: its docs page `{ slug, title }` in the sidebar;
   - `load`: **the loader.** `load: lazy("<id>", async () => { const { create<Cms>Adapter } = await
import("./<id>.js"); return (c, settings) => create<Cms>Adapter({ env: c.env, fetcher: c.fetcher, settings,
...(c.sleep ? { sleep: c.sleep } : {}) }); })`. This dynamic `import()` is the only way the adapter's code is
     reached, so the bundler gives it its own chunk and a WordPress-only run never loads the Shopify code.
     An entry file imports only types, `lazy` (`load.ts`) and plain data, never the adapter module.
3. Write its **contract file**, `packages/core/src/adapters/__tests__/<id>.contract.ts`, beside a recorded-response
   fixture (`<id>-fixture.ts`; invented content, no real client data; `sanity.contract.ts` is the example). It
   exports `contractEntries: readonly ContractEntry[]`. The contract suite (`contract.test.ts`, one `describe.each`
   over every entry) then runs against it with no test of yours needed for these rules: counts and fingerprints
   but never a value, a missing field counts 0, no request but GET or HEAD (or a POST that matches the entry's `queryAllow` with a body that is a query), a key that is refused is
   could-not-check, a rate limit is waited out once and then reported as partial. A platform that needs no key to
   read what is published (WordPress) sets `keyHeader` on its entry: the published reads then must carry no key,
   and only the reads that need it carry exactly that header. Tests may import the adapter module directly.
4. Run **`pnpm gen:adapters`**. It collects every `adapters/*.entry.ts` and `adapters/__tests__/*.contract.ts`
   into `adapters/entries.generated.ts` and `adapters/__tests__/contracts.generated.ts`, rewrites the table
   between the `adapters:start` and `adapters:end` markers in `docs/integrations/index.md`, and rewrites
   `docs/adapter-pages.generated.ts` (the adapters' pages in `docs/nav.ts`). Commit what it writes; CI runs
   `pnpm gen:adapters --check`. If two pull requests both add an adapter and the generated files conflict, run
   `pnpm gen:adapters` again after the rebase.
5. Write `docs/integrations/<id>.md` (the page named in `page.slug`) with a freelancer example, and add a changeset.

Code outside `adapters/<id>*.ts` (the CLI, `core/src/index.ts`, the check registries, the docs scripts) gets an
adapter with `createAdapter(built, context, settings)` or `createAdapters(config, context)` (both `async`), its
description with `adapterDescription(id)` and its variables with `adapterEnvVars(id)`, and never with a static
`import` of the adapter module; `adapters/__tests__/lazy.test.ts` fails the build if it does. A pull request that
changes code does not edit `PROGRESS.md` either (the gate in `scripts/lib/gate.ts` fails it unless it carries the
label `progress`): progress updates go in their own pull request after every five merges.

## Writing a recipe

A recipe is a small mapping in `gaugeline.adapters.json` that points the generic adapter at a headless
CMS's read API (Storyblok, Payload, Ghost, Drupal and others), so it needs no code. **Recipes arrive with
C-14 (`c/generic-api`) and are not on `main` yet**, so there is no recipe format to follow today and
`generic-api` is a planned adapter id that `gaugeline.adapters.json` refuses. Until C-14 has merged:

- If the platform's content must be read now, write a native adapter with `pnpm new:adapter` above.
- If you are preparing a recipe, write what C-14 will need and nothing more: the platform's documented
  read endpoints (with the date you read them), the narrowest key and how to make it, how a list is paged,
  where an item's id, slug, state, times and fields are in the answer, and an invented recorded response. The
  same rules apply as for an adapter (read only, fingerprints never content, the key from the environment,
  anything the platform does not expose is could-not-check).

When C-14 has merged, this section will describe the recipe format and the test every recipe must pass.

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

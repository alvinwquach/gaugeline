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
  (the CLI package, paths outside core, `exit`/`abort`/`kill`/`exitCode` from `process`),
  `no-restricted-properties` (`process.exit`, `abort`, `kill`) and `no-restricted-syntax`
  (assigning `process.exitCode`).
- **Test** (`packages/core/src/__tests__/boundary.test.ts`): parses every core source file with the
  TypeScript compiler API and fails with the file and line of any import that leaves the package,
  names the CLI, or calls `process.exit`. It catches dynamic `import()` and `import type`, and runs
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

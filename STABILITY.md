# Stability promise

CI pipelines branch on Gaugeline's exit codes, parse its JSON and name its check ids. This file says
what will not change without a major version, and what can change at any time.

## The public interface

- **Commands and flags**, as listed on the Options page and each command's docs page.
- **Exit codes**: 0 (ran), 1 (`--ci` and a "Fix this first" finding), 2 (could not run).
- **The `--json` shape**, identified by its schema number (`"schema": 2`, published as
  `packages/core/schema/result.v2.json`).
- **The `--save-requests` file shape**, identified by its own `schemaVersion` (`1`, published as
  `packages/core/schema/requests.v1.json`). It changes independently of the `--json` shape.
- **The work order data** (`Brief`, returned by `buildBrief` in `@gaugeline/core`), identified by its
  own `schemaVersion` (`1`, published as `packages/core/schema/brief.v1.json`). It changes
  independently of the `--json` shape and of the requests file.
- **Check ids**, such as `canonical-elsewhere`. An id that has shipped is never reused for a
  different rule (`docs/check-ids.lock.json`).
- **Environment variable names**, such as `CI`, `NO_COLOR` and later `GAUGELINE_SLACK_WEBHOOK`.

`public-surface.lock.json` is this list, derived from the code. CI fails when it changes without the
right changeset (`pnpm surface`).

## Supported Node versions

Gaugeline needs Node 22 or newer, and CI runs the whole suite on Node 22 and 24 on Linux, Windows and
macOS. Support ends with the Node release itself: when a Node version reaches end of life, the next
Gaugeline minor drops it and says so in the changelog. Under an older Node the command prints one
line and exits 2.

## Not public

- Terminal wording and layout.
- The HTML report's markup.
- Finding titles and evidence text. These are rewritten to be clearer whenever that helps.
- Anything in `packages/core` that its index does not export.

## Semver rules

| Change                                                             | Bump                                                |
| ------------------------------------------------------------------ | --------------------------------------------------- |
| Remove or rename a command, flag, check id or environment variable | major                                               |
| Change what an exit code means                                     | major                                               |
| Raise the JSON schema number                                       | major                                               |
| Add a check, a flag, a command or an optional JSON field           | minor                                               |
| Change a check's severity                                          | minor, with its own changelog line naming the check |
| Fixes, including a check that finds more or fewer cases            | patch                                               |

A severity change is minor, not patch, because with `--ci` a check moving from medium to high turns
a passing run into a failing one for someone who changed nothing.

**Before 1.0**, read "major" as "minor": a removal ships in a minor release (0.x.0). The rules are
otherwise the same, and `pnpm surface` says when it applied the pre-1.0 rule.

## Deprecation

Nothing public disappears without warning first:

1. Add the item to `DEPRECATED` in `packages/core/src/deprecate.ts` (key `--flag`, `check:<id>` or
   `env:NAME`) with `since` and `removeIn`, and mark the flag `deprecated` in the flag table.
2. While it is deprecated, using it prints one line on stderr per run, never on stdout, and never
   changes the exit code:
   `Deprecated: --old-flag will be removed in 0.4.0. Use --new-flag instead.`
3. It may be removed once the package version reaches `removeIn`, in a major (pre-1.0: minor)
   release. Removing it earlier fails `pnpm surface` with "not yet".

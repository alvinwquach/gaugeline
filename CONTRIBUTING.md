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
     A decision with no source is marked *uncited*.
   - **Architecture notes**: what was chosen, what it was chosen over, and what it costs.
   - **Tests**: what was added, and the counts.
4. Write the tests first: unit, integration, end-to-end, then edge cases.
   A change is done when they pass on Node 18.17, 20 and 22 in CI.
5. A user-facing change ships its docs page and a changeset file in the same pull request.

## Exit codes

| Code | Meaning |
|---|---|
| 0 | The check ran |
| 1 | `--ci` was set and a fix-first finding was found |
| 2 | Gaugeline could not run (bad arguments, the site could not be reached) |

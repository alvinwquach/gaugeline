# Tested docs examples

Every command a docs page shows as `$ npx gaugeline ...` runs in CI against an invented fixture site,
and its output is compared with the page. The page cannot drift from the tool.

## Writing an example

Put a fixture comment directly above a block titled `Terminal`, and the expected stdout in the next
block, titled `Output`:

````md
<!-- fixture: quick-start -->

```sh title=Terminal
$ npx gaugeline shop.example
```

```text title=Output
✗ This page tells Google to show a different page
    <link rel="canonical" href="https://shop.example/tools"> on https://shop.example/ (differs by path)

1 to look at, 1 to fix first.
```
````

- The fixture is a folder in `packages/fixtures/sites/`. The runner swaps the page's address for the
  fixture's local address and back again in the output.
- The runner uses the built CLI, never npx or the network, with `NO_COLOR=1`, and adds
  `--no-open` (unless `--json`) and `--allow-private`.
- An expected exit code other than 0 is declared with `<!-- exit: 1 -->` above the block.
- With `--json`, the Output block is compared as parsed JSON; key order does not matter.
- Environment variables in front of the command (`GAUGELINE_SLACK_WEBHOOK=... npx gaugeline ...`)
  are passed to the run; ones that hold an address point at a local sink, never a real one.

## What is normalised

Only this, on purpose: the fixture address becomes the page's address; the version after
"Gaugeline " becomes `X.Y.Z`; colour codes and trailing spaces are removed; absolute paths become
`./`; ISO timestamps become `2026-01-01T00:00:00.000Z`. A new source of variation needs a new
named rule, not fuzzy matching.

## Opting out

A block that cannot run (Docker, a feature not built yet) says why:

````md
```sh title=Terminal untested="Needs Docker."
$ docker run --rm node:20 npx gaugeline shop.example
```
````

`untested` without a reason is an error, and so is a `$ npx gaugeline` block with neither an Output
block nor `untested`.

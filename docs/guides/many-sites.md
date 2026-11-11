# Many sites from one file

You look after several sites. Running them one at a time, each with its own flags and keys, is the
part that gets skipped. List them once in `gaugeline.sites.json` and check them with one command.

## The sites file

In the folder you run from:

```json title=gaugeline.sites.json
{
  "sites": [
    {
      "name": "harbour",
      "address": "harbour-pottery.example",
      "config": "harbour",
      "keyPrefix": "HARBOUR",
      "tags": ["client"],
      "permission": { "by": "Sam at Harbour Pottery", "on": "2026-10-01" }
    },
    {
      "name": "fern-and-kiln",
      "address": "fernkiln.example",
      "tags": ["mine"],
      "permission": { "by": "me", "on": "2026-10-01" }
    }
  ]
}
```

| Field        | What it is                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------- |
| `name`       | Lower case, digits and hyphens. It names the site's run folder, `runs/<name>/`, so two sites can't share one            |
| `address`    | What you'd type for a single check                                                                                      |
| `config`     | A folder, relative to the sites file, holding this site's `gaugeline.*.json` files. Without it, the sites file's folder |
| `keyPrefix`  | `HARBOUR` reads `HARBOUR_<VARIABLE>` as `<VARIABLE>`: `HARBOUR_GAUGELINE_BASIC_AUTH` is its preview password            |
| `tags`       | Anything you group by, such as `mine` or `client`                                                                       |
| `permission` | Who agreed to the site being checked, and when. **A site without it is refused**, with a message saying what to add     |

- **Keys never go in the file**, only the prefix that names them. A preview's secret
  (`GAUGELINE_BASIC_AUTH`, `GAUGELINE_VERCEL_BYPASS`, `GAUGELINE_PREVIEW_HEADER`) is never shared
  between sites: set without a prefix it reaches none of them, so one site's password can't be sent
  to another site's address. Other variables without a prefix apply to every site.
- Two sites with the same name stop the run before anything is checked.

## Checking them

```sh
npx gaugeline run --all
npx gaugeline run --site harbour
npx gaugeline run --tag client --parallel 3
```

Each site is checked like `gaugeline <address>`, from its config folder, and saved to
`runs/<site>/<date>.json`. The run is compared with that site's previous one, so the summary at the
end says, worst first, what is new, what was fixed and how many fix-first findings are open, or why
the site couldn't run. One site failing never stops the rest.

- `--parallel 3` checks up to three sites at once. Sites on the same host are always checked one
  after the other, so two runs never press one server at the same time.
- A tag that matches nothing says so and checks nothing.
- **Exit codes:** 1 when any site has a new fix-first finding; otherwise 2 when a site couldn't
  run; otherwise 0. A site's first run has nothing to compare with, so nothing in it is new.

### Three sites, one unreachable

The invented sites in `packages/fixtures/sites-file`: `harbour` is clean on its first run,
`fern-and-kiln` has a noindex header that its last run didn't have, and `old-shop` answers nothing.
`gaugeline run --all` prints:

```text title=Output
Site             New  Fixed  Fix first
old-shop       couldn't run: 127.0.0.1:1 refused the connection.
fern-and-kiln      1      0          1
harbour            –      –          0  (first run: nothing to compare yet)
3 sites: 1 with a new fix-first finding, 1 couldn't run.
```

and exits 1, for the new fix-first finding on `fern-and-kiln`.

## Every night, with history

[`examples/workflows/nightly-all-sites.yml`](https://github.com/alvinwquach/gaugeline/blob/main/examples/workflows/nightly-all-sites.yml)
runs `gaugeline run --all` every night in GitHub Actions, commits the run files back so each night
compares with the last, and builds each site's [weekly digest](/docs/guides/weekly-digest) from them.
Each key comes from a secret named with the site's prefix (`HARBOUR_GAUGELINE_BASIC_AUTH`).
Add `--renewals` to the command to also read each site's domain registration, certificates and
tokens, so a date drifting closer is caught the night it crosses a threshold: [Renewals](renewals.md).

::: warning
Run files hold findings and their evidence. Keep the repository that stores them **private**.
:::

`gaugeline open runs/`, to see every site in the local app, comes with the local app (G21).

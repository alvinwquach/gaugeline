# Deploy gates: check a preview before it goes live

Vercel, Netlify and Cloudflare Pages build a preview for every pull request. A preview is where a missing
canonical link, a dead link or a stray `noindex` is cheapest to fix: nobody has seen it yet. `gaugeline
deploy-gate` runs the normal checks on a preview and ends with one line you can read at a glance.

```sh
npx gaugeline deploy-gate https://deploy-preview-7--brightside-dental.netlify.app
```

It is **report only**. Without `--block` the exit code is `0` whatever it finds (it is `2` only when the check
could not run, for example the preview did not answer), so adding it to a project can never stop a
deployment. When you trust it, add `--block` (or set `GAUGELINE_GATE_BLOCK=1` in the job) and it exits `1`
when a finding is marked "Fix this first", exactly like `--ci` on a normal run. The `CI` variable does not
turn blocking on, because every CI job sets it; `--ci` is not accepted here, so the gate cannot block by
accident.

## Which address it checks

The address you type, or, when you leave it out, the one the host's own environment holds:

| Host             | Variables it reads                                                   | Counts as a preview when                         |
| ---------------- | -------------------------------------------------------------------- | ------------------------------------------------ |
| Vercel           | `VERCEL_ENV`, `VERCEL_URL` (a host name; Gaugeline adds `https://`)  | `VERCEL_ENV` is `preview`                        |
| Netlify          | `CONTEXT`, `DEPLOY_PRIME_URL` (or `DEPLOY_URL` when that is missing) | `CONTEXT` is `deploy-preview` or `branch-deploy` |
| Cloudflare Pages | `CF_PAGES`, `CF_PAGES_BRANCH`, `CF_PAGES_URL`                        | the branch is not `main` or `master`             |

Cloudflare Pages does not say which deployment is production, so Gaugeline treats the branches `main` and
`master` as production. If your production branch has another name, give the gate the address from a job
that only runs for previews.

A gate for previews must not run on production as if it were a preview, so when the environment says
production the command stops before any request, with exit `2`, even if you typed an address. Two hosts'
variables at once with no address typed, an empty variable, or a value that is not a plain `https` host
(a path, a query, a user name or a password) are also refused, and the message names the variable without
repeating its value. Only the address is ever printed. A preview on your own computer or a private network
is refused unless you add `--allow-private`, as in every other command.

::: warning Variable names are uncited
The variable names above are the hosts' documented ones as far as could be told, but the vendors' pages
(Vercel's system environment variables, Netlify's build environment variables, Cloudflare Pages'
build configuration) could not be opened when this was written, so they are marked `uncited` in the pull
request. If a host renames one, a typed address always works.
:::

## It only looks

The checks are the ones every run makes: `GET` and `HEAD` requests to the preview, through the same fetcher,
with no login attempted. The probing checks (the ones that ask routes for what they protect) stay off unless
you add `--owner-consent` on the command line; a `gaugeline.consent.json` in the folder is not enough for the
gate. Run `--owner-consent` only on previews you own or have permission to test. A preview behind a password
is checked as described in [a protected preview](../ci.md#a-protected-preview); the bypass secret comes from the
environment and is never printed.

## Where to run it

A preview is only reachable once the host has finished deploying it, and a host's build runs before that.
So the dependable place is a CI job that starts after the preview is live and is handed its address. Where
the host reports the deployment to GitHub, that is a `deployment_status` workflow:

```yaml
name: Gaugeline deploy gate
on: deployment_status
jobs:
  gate:
    # Previews only: production deployments are skipped here, and the command refuses them if one gets through.
    if: github.event.deployment_status.state == 'success' && github.event.deployment.environment != 'Production'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5.0.0
        with:
          node-version: 24
      - env:
          TARGET_URL: ${{ github.event.deployment_status.target_url }}
        run: npx --yes gaugeline deploy-gate "$TARGET_URL"
```

- **Vercel**: reports each deployment to GitHub, with the environment `Preview` or `Production`. The job above
  works as written. A build step or `vercel.json` setting is not needed, and would run before the preview is
  live. If you turn on Vercel Authentication for previews, set `GAUGELINE_VERCEL_BYPASS` from a secret.
- **Netlify**: the deploy preview's address is in `DEPLOY_PRIME_URL` during the build, but the build runs
  before the preview is live, so a command in the build cannot reach it. Use the same job once your Netlify
  site reports deploys to GitHub, or any job that waits for the deploy preview and passes its address (the
  address of a deploy preview looks like `deploy-preview-7--your-site.netlify.app`). Use the environment name
  your host reports in the `if:` line.
- **Cloudflare Pages**: reports its deployments to GitHub in the same way; use the same job. `CF_PAGES_URL`
  is the address of one deployment.

With the host's variables in the job's environment (for example a job that copies them in), leave the
address out: `npx gaugeline deploy-gate`.

Hosts that give no event after a preview is live have no hook for this; run the gate from a job that polls
for the preview, or by hand from your laptop.

## Example: a dentist's Netlify deploy preview

Brightside Dental is an invented practice. You rebuilt its site on Netlify, and the pull request that adds
the whitening page has a deploy preview. The home page has no canonical link, and the new menu link points at
a page that is not there yet:

<!-- fixture: deploy-preview-dentist -->

```sh title=Terminal
$ npx gaugeline deploy-gate https://deploy-preview-7--brightside-dental.netlify.app
```

```text title=Output
✗ Links on this page go nowhere
    "Whitening" <a href="/whitening"> returned 404
· The page doesn't say which address is the real one
    no <link rel="canonical"> on https://deploy-preview-7--brightside-dental.netlify.app/
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

2 to look at, 1 to fix first.
gate: would block (1 fix-first finding); report only, add --block to fail the build
```

The gate would block the production deploy, and says so, but the build is still green and the exit code is
`0`. The missing canonical link is only worth a look; the broken link is the one to fix before it goes live.
Once the team trusts the gate, the same command with `--block` exits `1` on that link.

## Exit codes

| Code | Meaning                                                                                      |
| ---- | -------------------------------------------------------------------------------------------- |
| `0`  | The check ran. Without `--block` this is the code even when "Fix this first" findings exist  |
| `1`  | `--block`, and at least one finding is "Fix this first"                                      |
| `2`  | It could not run: production, no address, an unusable address, or the preview did not answer |

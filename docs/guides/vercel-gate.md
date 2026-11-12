# Hold a Vercel deploy on Gaugeline's result

You build on Vercel. A pull request gets a preview, and merging it to `main` makes the production deploy.
The moment to catch a stray `noindex`, a canonical that points at the wrong host or a dead menu link is
between those two, while nobody has seen the page. This guide holds the merge, and with it the production
deploy, on [`gaugeline deploy-gate`](./deploy-gates.md), using the CI and branch protection you already have.

**Gaugeline writes nothing to Vercel.** It does not register a check in Vercel, call a Vercel API or
hold a Vercel token. It looks at the preview with `GET` and `HEAD` requests, exits `1` on a fix-first finding,
and your CI and GitHub do the holding. Its findings stay in Gaugeline's own report.

## The setup, in three steps

1. Copy the workflow below to `.github/workflows/vercel-gate.yml` in the repository Vercel deploys.
2. Push it, and open a pull request so the job runs once. GitHub only offers a job as a required check after it
   has run.
3. In GitHub, go to Settings, Branches, and edit the rule for `main`: turn on "Require status checks to pass
   before merging" and pick **gate**. That one setting is what holds the merge.

```yaml title=".github/workflows/vercel-gate.yml"
# An example: copy it to .github/workflows/ in the repository Vercel deploys.
#
# Vercel reports every deployment to GitHub. This job runs when a Preview deployment is live, checks it
# with Gaugeline, and fails when a finding is marked "Fix this first". Gaugeline writes nothing to Vercel
# or to GitHub: GitHub holds the merge, because you make this job a required status check (Settings,
# Branches, branch protection rule for main, "Require status checks to pass"). A pull request cannot be
# merged until it has passed, so a preview that still says noindex never reaches production.
#
# Exit 1 means a fix-first finding; exit 2 means the check could not run (the preview did not answer, or
# it is locked and no bypass secret was given). Both fail the job: no answer is never a pass.
name: Gaugeline Vercel gate

on:
  deployment_status:

permissions:
  contents: read

jobs:
  gate:
    # Previews only. Use the environment name your project reports (Vercel says Preview).
    if: github.event.deployment_status.state == 'success' && github.event.deployment.environment == 'Preview'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5.0.0
        with:
          node-version: 24
      - name: Check the preview and fail on a fix-first finding
        env:
          # The address comes in through the environment, never pasted into the script.
          TARGET_URL: ${{ github.event.deployment_status.target_url }}
          # Only when Vercel Authentication protects previews; an unset secret is empty and ignored.
          # A run from a fork gets no secrets: a protected preview then exits 2, never a false pass.
          GAUGELINE_VERCEL_BYPASS: ${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}
        run: npx --yes gaugeline deploy-gate "$TARGET_URL" --block
```

The job has no Vercel token and read-only access to your repository. The only secret is the optional bypass
secret for previews behind Vercel Authentication, which comes from the environment and is never printed.

::: warning Run only on previews you own or have permission to test
The gate sends only `GET` and `HEAD` requests to the preview and attempts no login. The probing checks stay
off; do not add `--owner-consent` unless the preview is yours, or you have permission to test it.
:::

## Example: a pop-up's menu page that still says noindex

Ember Street Pop-Up is an invented street-food stall. While redesigning its site you copied a staging template
that carries `<meta name="robots" content="noindex, nofollow">`. The page looks right in a browser, and the
tag goes to production with the merge, so the stall would vanish from search. The gate, run by the workflow above
(shown here with an address typed, as it runs on your laptop):

<!-- fixture: vercel-noindex-preview -->
<!-- exit: 1 -->

```sh title=Terminal
$ npx gaugeline deploy-gate https://ember-street-popup-git-redesign.vercel.app --block
```

```text title=Output
✗ This page asks search engines not to list it
    <meta name="robots" content="noindex, nofollow"> on https://ember-street-popup-git-redesign.vercel.app/
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

1 to look at, 1 to fix first.
gate: blocked (1 fix-first finding)
```

Exit `1` fails the **gate** job, the pull request shows "Required: gate" in red and the merge button stays
off. Remove the tag, push, and the preview is rebuilt; Vercel reports the new deployment, the job runs again and
passes. A preview that does not answer exits `2`, which also fails the job: no answer is never a pass.

## Two ways to hold, and what Gaugeline does not do

- **Hold the merge (above).** Nothing reaches production until the pull request passes. This is the one
  this guide sets up, because every piece of it is yours: a workflow file and a branch rule.
- **Hold the promotion.** Vercel can build a production deployment without pointing your domain at it, and
  you promote it when you are ready. A job that runs the gate against the staged deployment and only then
  promotes it holds the domain instead of the merge. The Vercel command, flag and project setting for this
  are described from memory and are `uncited`: the Vercel documentation could not be opened when this was
  written. Check the current page for promoting a deployment before you build on it. Gaugeline plays the
  same part there: it exits `1`, and your job decides not to promote.

### Deferred to v1.1: a check inside Vercel

The first version of this branch was meant to show Gaugeline's conclusion inside Vercel, as a check on the
deployment that Vercel itself waits for before it promotes. That is deferred to v1.1: it needs
Gaugeline to register a check through Vercel's Checks API, which is a `POST` and a `PATCH` to your Vercel
project, and Gaugeline's rule is that a request to a platform is a read. Doing it needs a decision recorded
as a new architecture decision (one file allowed to send check results to your own project), a Vercel
integration that you create, its secret, a small service that receives Vercel's deployment webhooks and
checks their signature, and a place to run it. None of that exists yet, and nothing in this guide needs it.

## What the findings look like

Findings are in the job log, in the same format as every Gaugeline run. For a durable copy, run the gate
with `--json` in a step of your own and keep the file as a workflow artifact; the same formats as a normal
run are available.

## Exit codes

| Code | Meaning                                                                                      |
| ---- | -------------------------------------------------------------------------------------------- |
| `0`  | The preview was checked and no finding is marked "Fix this first"                            |
| `1`  | A finding is marked "Fix this first": the job fails and the merge stays held                 |
| `2`  | It could not run: production, no address, an unusable address, or the preview did not answer |

## Sources

- GitHub Actions `deployment_status` event, `github.event.deployment_status.target_url` and
  `github.event.deployment.environment`: `uncited` (the page was not opened while this was written). The
  `Preview` environment name is the one Vercel's GitHub integration reports, from the existing
  [deploy gates guide](./deploy-gates.md), which marks it the same way.
- Required status checks in branch protection rules: `uncited`.
- Vercel promoting a deployment and Vercel's Checks API: `uncited`; Vercel's documentation host was
  unreachable from the build session.

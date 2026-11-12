# Use it in CI

Fail a deploy when a page breaks, even if every test passed.

## GitHub Actions, after each deployment

```yaml title=.github/workflows/gaugeline.yml
name: Gaugeline
on: [deployment_status]
jobs:
  check:
    if: github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: npx gaugeline ${{ github.event.deployment_status.target_url }} --ci --notify-on high
        env:
          GAUGELINE_SLACK_WEBHOOK: ${{ secrets.GAUGELINE_SLACK_WEBHOOK }}
```

Vercel and Netlify both report preview deployments to GitHub, so this runs against every preview with real content.

## SARIF and JUnit: results your CI already reads

`--format` chooses what stdout carries. Both formats are views of the same run: the findings and their evidence line, nothing from the page beyond that line, and no key (a secret in an evidence line is replaced before it is written). Stdout is the result and nothing else, no report file is written, and the exit codes are the same as without it: 0, 1 with `--ci` and a "Fix this first" finding, 2 when the run could not be done.

| Value   | What it is                                                                                          | Where it goes                                  |
| ------- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| `json`  | The result, the same as `--json`                                                                    | Scripts                                        |
| `sarif` | [SARIF 2.1.0](https://docs.oasis-open.org/sarif/sarif/v2.1.0/sarif-v2.1.0.html), one rule per check | GitHub code scanning and other SARIF viewers   |
| `junit` | JUnit XML (`testsuites`, `testsuite`, `testcase`)                                                   | Jenkins, GitLab, CircleCI, any test-result tab |

Say a studio checks the preview of a dental practice's new site. The run writes SARIF to a file and still fails the job on a broken link:

```sh title=Terminal untested="The full output is 280 lines (one rule per check, a result per finding), so this page shows the first result and trims the rest. packages/core/src/report/__tests__/formats.test.ts and packages/cli/src/__tests__/format.test.ts run it and check the whole log against the SARIF schema."
$ npx gaugeline brightside-preview.example --format sarif --ci > gaugeline.sarif
```

```json title=Output
{
  "$schema": "https://docs.oasis-open.org/sarif/sarif/v2.1.0/errata01/os/schemas/sarif-schema-2.1.0.json",
  "version": "2.1.0",
  "runs": [
    {
      "tool": {
        "driver": {
          "name": "Gaugeline",
          "version": "X.Y.Z",
          "informationUri": "https://gaugeline.dev/",
          "rules": [
            {
              "id": "broken-links",
              "shortDescription": { "text": "Links on this page go nowhere" },
              "helpUri": "https://gaugeline.dev/docs/checks#broken-links",
              "defaultConfiguration": { "level": "error" }
            }
          ]
        }
      },
      "results": [
        {
          "ruleId": "broken-links",
          "ruleIndex": 0,
          "level": "error",
          "message": {
            "text": "Links on this page go nowhere\nEvidence: \"Prices\" <a href=\"/prices\"> returned 404"
          },
          "locations": [
            {
              "logicalLocations": [
                {
                  "fullyQualifiedName": "https://brightside-preview.example/prices",
                  "kind": "resource"
                }
              ]
            }
          ],
          "partialFingerprints": { "gaugeline/v1": "3ba56b7b03738062" }
        }
      ]
    }
  ]
}
```

(Trimmed: the real log also carries each rule's what, why and fix, and a `properties` object with the evidence and address.)

How a finding becomes SARIF:

- **Rule.** One per check that found something: its id, title, what it catches, how to fix it, and a link to its page in the checks reference.
- **Level.** "Fix this first" is `error`, "Fix soon" is `warning`, "Worth knowing" is `note`.
- **Location.** A finding from a repository check (one that names a file and line) gets that file and line. A finding about a live page has no file, so its location is the page address, as a logical location.
- **Fingerprint.** `partialFingerprints` holds the same fingerprint `--baseline` uses, so the same problem is the same alert from one run to the next, on a new preview address too.
- **Checks that could not run, or were left out** (the email checks without `--dns`) are notifications on the run, not results.
- **Suppressed findings.** A finding muted by a baseline or a dated suppression is written with a SARIF `suppressions` entry and the reason, so a viewer can show it as dismissed.

How a finding becomes JUnit:

- A "Fix this first" or "Fix soon" finding is a `failure` (its `type` says which). A "Worth knowing" finding is a passing test case with the evidence as its output.
- Every check that passed is a passing test case, so a clean site is a run with test results and no failures, not an empty report (Jenkins, for one, rejects an empty one).
- A check that could not run is an `error`. A page the site refused, a check left out on purpose, and a muted finding are `skipped`, with the reason as the message.
- Titles and evidence are escaped, and characters XML 1.0 cannot hold are dropped.

Both formats are checked in the repository's tests: SARIF against a schema written from the 2.1.0 specification, JUnit against the Jenkins `junit-10.xsd` (see `packages/core/src/report/__tests__/schemas/README.md` for why the SARIF schema is not the OASIS file).

## The GitHub Action

`action.yml` at the root of the repository is a composite action. It runs the published CLI with `npx`, keeps the SARIF file, uploads it to GitHub code scanning with GitHub's own `upload-sarif` action, and fails the job when you said it should. It reads the site with GET and HEAD requests only, like the CLI, and makes no request of its own to GitHub: the upload is the official step, and nothing else writes to your repository.

```yaml title=.github/workflows/gaugeline.yml
name: Gaugeline
on: pull_request
permissions:
  contents: read
  security-events: write # upload to code scanning
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: alvinwquach/gaugeline@<commit-sha> # pin by commit, like every action you use
        with:
          url: https://brightside-pr-${{ github.event.number }}.example/
          version: <x.y.z> # the release you pin
          fail-on: high
```

| Input           | Default     | What it does                                                                                                                                |
| --------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`           | required    | The address to check, usually a preview deployment                                                                                          |
| `version`       | required    | The exact `gaugeline` release `npx` runs, such as `1.2.3`: the release you pin. There is no default and no `latest`; see below              |
| `fail-on`       | `high`      | `high` fails the job on a "Fix this first" finding, `medium` also on "Fix soon", `never` on no finding. A check that could not run fails it |
| `upload-sarif`  | `true`      | Uploads the SARIF file to code scanning (needs `security-events: write`)                                                                    |
| `category`      | `gaugeline` | The code scanning category. Give each use of the action in one workflow its own, or a later upload replaces an earlier one                  |
| `allow-private` | `false`     | Lets the check read a private-network address, such as a self-hosted runner's staging server                                                |

Outputs: `sarif-file` (its path), `high` and `medium` (how many findings, muted ones not counted).

- **The version is the release you pin.** The action runs `npx gaugeline@<version>` and refuses anything that is not an exact release number (`1.2.3`, or `1.2.3-rc.1`): a tag such as `latest`, a range, a URL or another package name stops the step before anything runs. A moving name would run whatever is published under it, with your workflow's secrets in the environment. The `gaugeline` package must be published on npm before the action can run at all; until the first release exists, there is no version to pin.
- **Probing checks are off.** The action never passes `--owner-consent` or any probing flag, and has no input for them. It runs the default, read-only checks. Probing checks ask for non-public paths or use a site's own keys, so run them only on sites you own or have permission to test, with the CLI.
- **The CLI reads `gaugeline.config.json` from the workspace.** A pull request that edits that file changes what the check runs and what blocks. Protect the file with branch protection or code owners, or run the action from a workflow that checks out the base branch.
- **Code scanning needs a public repository or GitHub Advanced Security.** A private repository must have GitHub Advanced Security turned on for code scanning; without it the upload step fails and the check itself is unaffected. Set `upload-sarif: "false"` to keep the job and the `fail-on` check without the upload.
- **The SARIF file is uploaded even when the job fails**, so a failing run still shows its findings in the Security tab. The job fails afterwards, in its last step.
- **A pull request from a fork** has a read-only token, so the upload cannot work there ("Resource not accessible by pull request"). The upload step is set to `continue-on-error` on a fork's pull request, so the missing upload never turns the job red; the check still runs and still fails the job on `fail-on`. If you call `upload-sarif` yourself, use `if: github.event.pull_request.head.repo.fork != true` on that step.
- **Muted findings.** `fail-on` and the `high` and `medium` outputs do not count a finding that has a SARIF suppression (a baseline or a dated suppression).
- **Size.** GitHub limits the size of a SARIF upload (its code scanning documentation has the current numbers). One site's log is small: each evidence line is cut at 500 characters. If you check a very large site and the upload is refused for size, check fewer pages per run.
- **No `npx` on the runner?** GitHub's own runners have Node. A self-hosted runner needs Node 22 or later.
- **A pull request comment** is planned for v1.1 together with an amendment of ADR-0005 (a comment is a write to your repository, so it needs its own decision). It is not in this version.

### Try the upload once, on a public scratch repository

Before you rely on it, run one upload in a repository you can throw away. On GitHub, create a public repository (for example `gaugeline-sarif-scratch`), which needs no Advanced Security, then:

1. Add `.github/workflows/gaugeline.yml` with the workflow above, with `on: [push, workflow_dispatch]`, `url: https://example.com/` (any public site you may check), `version:` set to a published release, `fail-on: never`, and the action pinned to the commit of this repository you want to try.
2. Keep the two permissions, `contents: read` and `security-events: write`. Nothing else is needed.
3. Push, or run the workflow from the Actions tab. The step named **Upload SARIF** should end green.
4. Open the repository's **Security** tab, then **Code scanning**. Each Gaugeline finding is an alert whose rule is the check's id. A finding about a live page has no file in your repository, so open one to read its title, evidence line and address.
5. If the **Upload SARIF** step fails, read its log: a rejected log names what it did not accept.

### If GitHub rejects the upload

A finding about a live page has no file in your repository, so Gaugeline writes its address as a logical location and no file location. GitHub code scanning may require a file for every result. If the **Upload SARIF** step is refused for that reason, nothing is lost: the SARIF file is still the step's `sarif-file` output and can be read as JSON. The fix is a switch in the code that is off until a real upload says it is needed: `SARIF_PHYSICAL_LOCATION_FALLBACK` in `packages/cli/src/main.ts`. Turned on, every page finding also carries a placeholder file, `gaugeline-pages/<host>/<path>` (a path ending in `/` becomes `.../index`) at line 1, which names no real file in your repository. Open an issue with the step's log line and it will be turned on in a release.

## A protected preview

A preview behind deployment protection answers every request with a login page. Store its secret
as a CI secret and pass it in the environment; Gaugeline sends it only to the checked address and
never prints it:

```yaml title=.github/workflows/gaugeline.yml
- run: npx gaugeline plan sitemap.csv --base ${{ github.event.deployment_status.target_url }}
  env:
    # Vercel: Project Settings → Deployment Protection → Protection Bypass for Automation
    GAUGELINE_VERCEL_BYPASS: ${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}
    # Or basic auth, as user:password:
    # GAUGELINE_BASIC_AUTH: ${{ secrets.PREVIEW_BASIC_AUTH }}
```

The same variables work for a plain check (`npx gaugeline <preview>`). Without them, a locked
preview exits 2 ("could not run"), never 1, so the job fails for the right reason. See
[A preview behind a password](/docs/plan-check#a-preview-behind-a-password).

## Gate a launch on the plan

[`examples/workflows/plan-gate.yml`](https://github.com/alvinwquach/gaugeline/blob/main/examples/workflows/plan-gate.yml)
runs the plan check twice: on every change to the plan file (`--plan-only`, no site), and after
every successful deployment (`--base` the preview). Both exit 1 when anything drifts and 2 when the
check could not run, so as required status checks they hold the merge or the promotion to
production (see [Gate a launch](/docs/plan-check#gate-a-launch)):

```yaml title=.github/workflows/plan-gate.yml
on:
  pull_request:
    paths: [docs/sitemap-plan.csv]
  deployment_status:
jobs:
  plan-only:
    if: github.event_name != 'deployment_status'
    runs-on: ubuntu-latest
    steps:
      # checkout and setup-node (Node 24), then:
      - run: npx --yes gaugeline plan docs/sitemap-plan.csv --plan-only
  plan-against-preview:
    if: github.event_name == 'deployment_status' && github.event.deployment_status.state == 'success'
    runs-on: ubuntu-latest
    steps:
      # checkout and setup-node (Node 24), then:
      - run: npx --yes gaugeline plan docs/sitemap-plan.csv --base "$TARGET_URL"
        env:
          TARGET_URL: ${{ github.event.deployment_status.target_url }}
          GAUGELINE_VERCEL_BYPASS: ${{ secrets.VERCEL_AUTOMATION_BYPASS_SECRET }}
```

## Content a script or a model wrote

A pipeline that writes content (a weekly meal plan, a batch of product descriptions) can state a total that its parts do not add up to, or link to a document nobody published. `gaugeline query` checks both from the repository's workflow: each rule is one read-only request to your Sanity dataset, and only ids and counts come back (see [Content that has to add up](/docs/query-check#content-that-has-to-add-up)).

```yaml title=.github/workflows/content.yml
- run: >
    npx --yes gaugeline query ./src --ci
    --totals "mealPlan:targetCalories=days[].meals[]->calories"
    --refs "mealPlan:days[].meals"
  env:
    SANITY_PROJECT_ID: ${{ vars.SANITY_PROJECT_ID }}
    SANITY_DATASET: production
```

The job exits 1 when a plan states a number its meals do not add up to, or links to a meal that was never published. A private dataset also needs `SANITY_TOKEN`, a read-only token with the Viewer role, in the secrets context (see [Private datasets](/docs/private-datasets)).

## Failing only on gaps a pull request created

A site that has been live for a year has gaps, and a check that fails on all of them is switched off by the second week. `gaugeline query` can fail a pull request only for the gaps that pull request created. Save a baseline on the main branch and commit it (it holds names: check ids, document types, field names and file paths, no token and no content), then compare each pull request with it ([how the baseline works](/docs/query-check#before-a-restructure)):

```yaml title=.github/workflows/queries.yml
- run: npx --yes gaugeline query ./src --against gaugeline.baseline.json --ci
  env:
    SANITY_PROJECT_ID: ${{ vars.SANITY_PROJECT_ID }}
    SANITY_DATASET: production
```

```sh title=Terminal untested="Writes a file in your repository and needs a Sanity project. docs/query-check.md runs the same two commands in an invented repository and shows their output."
$ npx gaugeline query ./src --save gaugeline.baseline.json --force   # on main, when you accept today's gaps
```

The job exits 1 only when the pull request created a gap that is "Fix this first", for example a query that now asks for a field no document has. A gap that was already in the baseline does not fail it, high or not. It exits 2, and the job fails for the right reason, when the baseline is missing, edited or from a newer Gaugeline. Run it from the same folder you saved from, so the paths match. When a pull request fixes old gaps, save the baseline again so they stay fixed.

## The 30-day cutover watch

[`examples/workflows/cutover-watch.yml`](https://github.com/alvinwquach/gaugeline/blob/main/examples/workflows/cutover-watch.yml)
runs `gaugeline plan --watch` once a day after a migration and is red only when something new
drifts (see [After cutover, the 30-day watch](/docs/plan-check#after-cutover-the-30-day-watch)):

```yaml title=.github/workflows/cutover-watch.yml
on:
  schedule:
    - cron: "17 6 * * *"
  workflow_dispatch:
jobs:
  watch:
    runs-on: ubuntu-latest
    steps:
      # checkout and setup-node, then:
      - uses: actions/cache/restore@caa296126883cff596d87d8935842f9db880ef25 # v5.1.0
        with:
          path: .gaugeline/plan-state.json
          key: gaugeline-watch-${{ github.run_id }}
          restore-keys: gaugeline-watch-
      - run: npx --yes gaugeline plan plan.csv --base https://yoursite.com --watch 2026-11-01 --notify-on any
        env:
          GAUGELINE_SLACK_WEBHOOK: ${{ secrets.GAUGELINE_SLACK_WEBHOOK }}
      - uses: actions/cache/save@caa296126883cff596d87d8935842f9db880ef25 # v5.1.0
        if: always() && hashFiles('.gaugeline/plan-state.json') != ''
        with:
          path: .gaugeline/plan-state.json
          key: gaugeline-watch-${{ github.run_id }}
```

- The state lives in the Actions cache. Each save has its own key (the run id), and `restore-keys`
  takes the newest by prefix, so two overlapping runs don't overwrite each other. A cache entry
  can be evicted (one not used for a week, or when a repository passes 10 GB); a daily job uses
  it every day, and an evicted one is a new baseline, not an alarm.
- GitHub turns off scheduled workflows in a repository with no activity for 60 days. A 30-day
  watch ends before that.
- The Slack address comes from the secrets context; no address or token is written in the file.

## Docker

```sh title=Terminal
$ docker run --rm node:20 npx gaugeline yoursite.com --ci
```

::: info
Tests check your code and run when code changes. Gaugeline checks the content your code renders. See [the FAQ](/docs/faq) for how they fit together.
:::

## We run this on our own docs

Gaugeline checks its own docs site with the CLI built from the commit under test: on every
successful preview deploy, and every night against production. The workflow is
[`.github/workflows/dogfood.yml`](https://github.com/alvinwquach/gaugeline/blob/main/.github/workflows/dogfood.yml).
It uploads the report and `findings.json` as the `gaugeline-self-check` artifact, writes a summary
to the job page, and keeps one issue open while production has a "Fix this first" finding. An exit
code of 2 means the site did not answer, and is reported as an outage, not a finding. Findings we
accept for now are listed on [Known findings](/docs/known-findings).

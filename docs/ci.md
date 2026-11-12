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

`action.yml` at the root of the repository is a composite action. It runs the published CLI with `npx`, keeps the SARIF file, uploads it to GitHub code scanning, posts one pull request comment, and fails the job when you said it should. It reads the site with GET and HEAD requests only, like the CLI; the only thing it writes is that one comment, in your own repository, with the job's own token.

```yaml title=.github/workflows/gaugeline.yml
name: Gaugeline
on: pull_request
permissions:
  contents: read
  security-events: write # upload to code scanning
  pull-requests: write # the one comment
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: alvinwquach/gaugeline@<commit-sha> # pin by commit, like every action you use
        with:
          url: https://brightside-pr-${{ github.event.number }}.example/
          fail-on: high
```

| Input           | Default  | What it does                                                                                                                                |
| --------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `url`           | required | The address to check, usually a preview deployment                                                                                          |
| `fail-on`       | `high`   | `high` fails the job on a "Fix this first" finding, `medium` also on "Fix soon", `never` on no finding. A check that could not run fails it |
| `comment`       | `true`   | `true` posts one comment and edits it on every later run; `false` posts none                                                                |
| `upload-sarif`  | `true`   | Uploads the SARIF file to code scanning (needs `security-events: write`)                                                                    |
| `version`       | `latest` | The `gaugeline` version `npx` runs. Pin it, so a release never changes a build                                                              |
| `allow-private` | `false`  | Lets the check read a private-network address, such as a self-hosted runner's staging server                                                |

Outputs: `sarif-file` (its path), `high` and `medium` (how many findings, muted ones not counted).

- **One comment.** The comment carries a hidden marker. The next run finds it and edits it, so a pull request with twenty pushes still has one comment.
- **A pull request from a fork** has a read-only token, so no comment is tried: the job prints a notice, and the check still reports and still fails on `fail-on`.
- **Muted findings.** The comment and `fail-on` do not count a finding that has a SARIF suppression (a baseline or a dated suppression).
- **Not a pull request?** `comment: true` on a push or a deployment does nothing but print a notice.
- **No `npx` on the runner?** GitHub's own runners have Node. A self-hosted runner needs Node 20 or later.

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

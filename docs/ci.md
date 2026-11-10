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

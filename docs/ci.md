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

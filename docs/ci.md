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

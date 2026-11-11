# CI templates: GitLab CI, Bitbucket Pipelines and CircleCI

You build a site for a client, for example a neighbourhood bar on Sanity, Next.js and Vercel, and the
repository is not on GitHub. These three templates run Gaugeline every night against the live site and
fail the pipeline when something that costs the bar customers is broken: the opening hours page
returning a 404, a menu PDF that no longer loads, a booking link that points nowhere.

They run the same command and use the same exit codes as the checks in [Use it in CI](/docs/ci):

| Code | Meaning                                                                           |
| ---- | --------------------------------------------------------------------------------- |
| `0`  | The check ran, and nothing is marked "Fix this first"                             |
| `1`  | At least one finding is "Fix this first" (`--ci`)                                 |
| `2`  | Gaugeline could not run, for example the site did not answer or asked for a login |

Each template passes the code through unchanged, so a pipeline that fails with exit 2 means "look at the
setup", and exit 1 means "look at the report". The command is `npx --yes gaugeline "$SITE_URL" --ci --no-open`;
`--no-open` and `--ci` are the documented flags in [Options](/docs/options), and the HTML report
(`gaugeline-report.html`) is saved as a build artifact so the client's problem list is one click away.
Every template needs Node 22 or newer (the images are Node 24) and caches the npm cache (`~/.npm`) between runs.

## Set the variables, never the keys

Create these in the CI service's variable settings, not in the file:

| Variable                  | What it is                                                                    |
| ------------------------- | ----------------------------------------------------------------------------- |
| `SITE_URL`                | The site to check, for example `https://example.com`                          |
| `GAUGELINE_SLACK_WEBHOOK` | Optional. Where a summary goes ([Send results anywhere](/docs/notifications)) |

Mark the webhook masked or secured, and leave it out of the template: Gaugeline reads `GAUGELINE_*`
variables from the environment, and the templates never print them. Other keys work the same way:
[A protected preview](/docs/ci#a-protected-preview) shows `GAUGELINE_VERCEL_BYPASS`.

::: warning
The templates run the default checks only. The probing checks (`--owner-consent`) are off, and stay off
unless you add the flag yourself: run them only on sites you own or have permission to test.
:::

## GitLab CI

Add the job to `.gitlab-ci.yml`. Then open Build > Pipeline schedules and create a schedule such as
`43 4 * * *`. The report is kept for 30 days, even when the job fails.

```yaml title=gitlab-ci.yml
# GitLab CI: check a site every night with Gaugeline.
# Copy the job into .gitlab-ci.yml, or save this file and add `include: { local: gitlab-ci.yml }`.
#
# Variables: Settings > CI/CD > Variables.
#   SITE_URL                 the site to check, for example https://example.com
#   GAUGELINE_SLACK_WEBHOOK  optional: where a summary goes. Add it as Masked; never write it here.
# Schedule: Build > Pipeline schedules > New schedule (for example "43 4 * * *").
#
# Exit codes are the job's exit codes, unchanged: 0 the check ran, 1 a "Fix this first"
# finding, 2 Gaugeline could not run. The report is saved even when the job fails.
variables:
  npm_config_cache: "$CI_PROJECT_DIR/.npm"

gaugeline:
  image: node:24
  cache:
    key: gaugeline-npm
    paths:
      - .npm/
  rules:
    - if: '$CI_PIPELINE_SOURCE == "schedule"'
    - if: '$CI_PIPELINE_SOURCE == "web"'
  script:
    - npx --yes gaugeline "$SITE_URL" --ci --no-open
  artifacts:
    when: always
    expire_in: 30 days
    paths:
      - gaugeline-report.html
```

## Bitbucket Pipelines

Add this to `bitbucket-pipelines.yml`, then open Repository settings > Pipelines > Schedules and
schedule the `gaugeline-nightly` custom pipeline. Bitbucket keeps artifacts only from steps that
succeed, so the check step always succeeds, saves its exit code, and the second step exits with it.

```yaml title=bitbucket-pipelines.yml
# Bitbucket Pipelines: check a site every night with Gaugeline.
# Copy this into bitbucket-pipelines.yml.
#
# Variables: Repository settings > Pipelines > Repository variables.
#   SITE_URL                 the site to check, for example https://example.com
#   GAUGELINE_SLACK_WEBHOOK  optional: where a summary goes. Add it as Secured; never write it here.
# Schedule: Repository settings > Pipelines > Schedules > New schedule, pick the custom
# pipeline "gaugeline-nightly" and a time.
#
# Exit codes are kept: step 1 saves the code and the report, step 2 exits with that same
# code (0 the check ran, 1 a "Fix this first" finding, 2 Gaugeline could not run).
# Saving the report in its own step means it is kept even when the check finds something.
image: node:24

definitions:
  caches:
    npm: ~/.npm

pipelines:
  custom:
    gaugeline-nightly:
      - step:
          name: Check the site
          caches:
            - npm
          script:
            - code=0; npx --yes gaugeline "$SITE_URL" --ci --no-open || code=$?; echo "$code" > gaugeline-exit-code
          artifacts:
            - gaugeline-report.html
            - gaugeline-exit-code
      - step:
          name: Pass the result on
          script:
            - exit "$(cat gaugeline-exit-code)"
```

## CircleCI

Add this to `.circleci/config.yml`. The `nightly` workflow is a scheduled workflow on `main`. The report
appears under the job's Artifacts tab.

```yaml title=circleci-config.yml
# CircleCI: check a site every night with Gaugeline.
# Copy this into .circleci/config.yml.
#
# Variables: Project Settings > Environment Variables.
#   SITE_URL                 the site to check, for example https://example.com
#   GAUGELINE_SLACK_WEBHOOK  optional: where a summary goes. CircleCI hides the value; never write it here.
# The nightly run is the workflow below (a scheduled workflow, 04:43 UTC, on main).
#
# Exit codes are kept: the check step saves its code, the report and the cache are stored,
# and the last step exits with that same code (0 the check ran, 1 a "Fix this first"
# finding, 2 Gaugeline could not run).
version: 2.1

jobs:
  gaugeline:
    docker:
      - image: cimg/node:24.11
    steps:
      - restore_cache:
          keys:
            - gaugeline-npm-v1
      - run:
          name: Check the site
          command: |
            code=0; npx --yes gaugeline "$SITE_URL" --ci --no-open || code=$?; echo "$code" > gaugeline-exit-code
      - save_cache:
          key: gaugeline-npm-v1
          paths:
            - ~/.npm
      - store_artifacts:
          path: gaugeline-report.html
      - run:
          name: Pass the result on
          command: exit "$(cat gaugeline-exit-code)"

workflows:
  nightly:
    triggers:
      - schedule:
          cron: "43 4 * * *"
          filters:
            branches:
              only: main
    jobs:
      - gaugeline
```

## What a run looks like

The same command on your own computer, against the invented Corner Bar site, prints this and exits 1,
which is what makes the pipeline fail (the report is also written to `gaugeline-report.html`):

<!-- fixture: corner-bar -->
<!-- exit: 1 -->

```sh title=Terminal
$ npx gaugeline yoursite.com --ci --no-open
```

```text title=Output
✗ This page tells Google to show a different page
    <link rel="canonical" href="https://yoursite.com/menu"> on https://yoursite.com/ (differs by path)
! Some buttons open an email instead of a form
    Opens an email instead of a form: "Book a table" (mailto:tables@cornerbar.example).
! This page isn't set up for phone screens
    no <meta name="viewport"> on https://yoursite.com/
· Some images have no alt attribute
    1 image has no alt: /patio.png
· Images use older, heavier file formats
    2 of 2 sampled images are JPEG, PNG or GIF only: /taps.png, /patio.png
· Shared links have no picture
    no og:image on https://yoursite.com/
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

6 to look at, 1 to fix first.
```

How to read it: [Reading the report](/docs/reading-the-report).

## Choices you can change

- Several clients: run `gaugeline run --all` instead, see [Many sites from one file](/docs/guides/many-sites).
- Only fail on exit 2 (the site is down) and keep exit 1 as a warning: in GitLab CI add
  `allow_failure: { exit_codes: 1 }` to the job. The other two services need a script change; keep the
  default unless the client asked for it.
- A JSON copy of the result: add a second command with `--json > gaugeline.json` and list the file next to the report.

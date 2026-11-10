# Options

What stays stable between versions, and what may change, is written down in
[STABILITY.md](https://github.com/alvinwquach/gaugeline/blob/main/STABILITY.md).

Every flag the CLI accepts.

| Flag                                           | Does                                                                                                                                           |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `--ci`                                         | Exits with code 1 if anything is marked “Fix this first”. Also on when the CI environment variable is set                                      |
| `--json`                                       | Prints findings as JSON instead of the terminal summary, and skips the report. Also with `gaugeline ads`, for the export's result              |
| `--no-open`                                    | Writes the report without opening a browser                                                                                                    |
| `--demo`                                       | With `gaugeline open`: starts the app with example results and requests nothing. See [Open the app](/docs/the-app#try-it-with-example-results) |
| `--ads <file>`                                 | With `gaugeline open`: starts the app with an ads export read from this file. See [Ad landing pages](/docs/ad-landing-pages#in-the-app)        |
| `--help`                                       | Shows usage                                                                                                                                    |
| `--slack`, `--discord`, `--email`, `--webhook` | Send the results somewhere. See [Send results anywhere](/docs/notifications)                                                                   |
| `--notify-on`, `--report-url`                  | Control when messages are sent, and link to a hosted report                                                                                    |

Two commands read ad links. `gaugeline ads <export.csv>` takes `--json`, `--ci` (exit 1 when a landing page doesn't load or another "Fix this first" finding is found) and `--allow-private`, and `gaugeline tags <link>` follows one link through its redirects and takes `--ci` and `--allow-private`; see [Ad landing pages](/docs/ad-landing-pages#campaign-tags-are-lost).

## Exit codes

| Code | Meaning                                                                       |
| ---- | ----------------------------------------------------------------------------- |
| `0`  | The check ran. Without `--ci`, this is the code even when problems were found |
| `1`  | `--ci` mode, and at least one finding is “Fix this first”                     |
| `2`  | The check couldn't run, for example the site didn't answer                    |

## Deprecated

Flags and environment variables that are going away, with the version they will be removed in.
Using one prints a single warning on stderr; see [STABILITY.md](https://github.com/alvinwquach/gaugeline/blob/main/STABILITY.md).

| Flag or variable | Deprecated in | Removed in | Use instead |
| ---------------- | ------------- | ---------- | ----------- |
| (none yet)       |               |            |             |

## In this version

What the code in this repository does today. The sections above describe the product as published on the site.

### Usage

`gaugeline --help` prints:

```text title=Output
Usage: gaugeline <address> [options]

Check a website the way search engines and visitors see it. Read-only.

Options:
      --ci                       Exit 1 when a "Fix this first" finding is found
                                 [CI]
      --json                     Print the result as JSON on stdout, and nothing
                                 else
      --no-open                  Do not open anything in a browser
      --allow-private            Allow addresses on this computer or a private
                                 network, such as 127.0.0.1 or 192.168.x.x
      --allow-secret-key         Use a Stripe secret key, with a notice, instead
                                 of refusing it; a restricted key is safer
      --dns                      Also read the domain's mail records (SPF and
                                 DMARC) from DNS
      --owner-consent            Run the probing checks, which ask routes for
                                 what they protect with no login; only on sites
                                 you may test
      --routes <value>           With --owner-consent, find download routes in
                                 route files matching this glob (repeatable)
      --since <value>            Page check: compare with the last run (the only
                                 value is last). delivery: the window to read,
                                 such as 7d
  -i, --interactive              Open a terminal view of the results to move
                                 through, filter and dismiss findings
      --slack <value>            Send a summary to this Slack incoming webhook
                                 (or set GAUGELINE_SLACK_WEBHOOK)
      --discord <value>          Send an embed to this Discord webhook (or set
                                 GAUGELINE_DISCORD_WEBHOOK)
      --webhook <value>          POST the result as JSON to this address (or set
                                 GAUGELINE_WEBHOOK)
      --email <value>            Email the full report to these addresses
                                 through Resend (or set GAUGELINE_EMAIL)
      --notify-on <value>        When to send: any (something was found, the
                                 default), high or always
      --report-url <value>       Link each message to a hosted copy of the
                                 report at this address
      --save-requests <value>    Save the requests made and the page's data to
                                 this JSON file; it may contain page content, so
                                 do not commit it
      --quiet                    Print only results and errors
      --verbose                  Show each request, and technical detail when
                                 something goes wrong
  -h, --help                     Show this help and exit
  -v, --version                  Print the version and exit

Exit codes: 0 ran, 1 --ci with a fix-first finding, 2 could not run
```

```
gaugeline <address> [options]
```

### Exit codes

| Code | Meaning                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------ |
| 0    | The check ran                                                                                    |
| 1    | `--ci` was set and a "Fix this first" finding was found                                          |
| 2    | Gaugeline could not run, for example the site didn't answer, or a plan page asked for a password |

When Gaugeline exits 2 it prints one plain sentence and one thing to try on stderr, and nothing on
stdout. For example:

```
$ npx gaugeline shop.exmaple
shop.exmaple could not be found. Check the spelling.
Try: Type the address the way it appears in a browser, for example example.com.
```

```
$ npx gaugeline http://127.0.0.1:4000
127.0.0.1:4000 refused the connection.
Try: Check the site is running, and the port if you typed one.
```

`--verbose` adds the technical detail after a blank line: the stack and every underlying cause.
Query strings and anything that looks like a key are removed from both forms.

### Plan progress

`gaugeline plan <plan> --base <address> --progress [file]` compares with the last run of the plan
and prints what was fixed and what is new; the state file defaults to `.gaugeline/plan-state.json`
beside the plan. `--all` lists the findings still open, which otherwise print as a count. Without
`--progress` nothing is read or written. See
[Watching a preview fill in](/docs/plan-check#watching-a-preview-fill-in).

### Protected previews

Three environment variables, read once at start, open a protected preview for `gaugeline plan
--base` and for a plain check. No flag takes a secret; `--password` and the like are refused with
the variable to set.

| Variable                   | Sent as                                | Form            |
| -------------------------- | -------------------------------------- | --------------- |
| `GAUGELINE_VERCEL_BYPASS`  | `x-vercel-protection-bypass`           | the secret      |
| `GAUGELINE_BASIC_AUTH`     | `Authorization: Basic` (UTF-8, base64) | `user:password` |
| `GAUGELINE_PREVIEW_HEADER` | that one header                        | `Name: value`   |

They are sent only to the checked origin, never printed, and over `http` only to `127.0.0.1` and
`localhost`. A malformed one exits 2, naming the variable but not its value. See
[A preview behind a password](/docs/plan-check#a-preview-behind-a-password).

### Comparing with the last run

`--since last` compares this run with the last one saved for the same site, reports what changed,
then saves this run in its place:

```bash
npx gaugeline yoursite.com --since last
```

- `price-changed` (worth knowing): a product's price in the structured data is different.
- `form-provider-changed` (fix first): a form now posts to a different service (HubSpot to
  Formstack, say).
- `form-destination-changed` (fix soon): the same service, a different address.
- `nav-changed`: a link in the header or footer menu was added, removed, moved or renamed (see
  [Navigation and footer](/docs/guides/navigation)).
- `page-lost-content`, `page-lost-items`, `page-lost-structured-data` and `page-gone`: a page read
  last time lost content, list items or structured data, or is gone (see
  [Page snapshots](/docs/guides/page-snapshots)). New pages, sections and items are printed on stderr
  under "Since the last run", never as findings.

The run is saved in `.gaugeline/last-run/<host>.json` in the folder you run from: hosts, amounts and
provider names, word counts, headings and item addresses only, never form values, page text or keys. Without `--since` nothing is read or
written. The first run prints `nothing to compare yet` on stderr and saves. A file Gaugeline can't
read is replaced with a warning. A file written by a newer version (another schema) is left alone,
and nothing is compared. Delete the folder to start again. Two forms with no id or name that swap
places on the page read as a change: give forms an id.

### Moving through the results

`gaugeline <address> -i` opens a terminal view after the run, and `gaugeline view run.json` opens a
run saved with `--json`. Findings are on the left, grouped by level, with what couldn't be checked
last; the selected one is on the right, with why it matters and, after enter, how to fix it.

| Key              | Does                                                            |
| ---------------- | --------------------------------------------------------------- |
| arrows, `j`, `k` | Move                                                            |
| enter            | Show how to fix the selected finding                            |
| `/`              | Filter by title, check id or evidence; enter or esc to finish   |
| `d`              | Dismiss the selected finding: type the reason, enter to save it |
| `q`              | Quit                                                            |

A dismissal is written to `gaugeline.ignore.json` in the folder you run from, with its reason and
date, and later runs leave that finding out (with one line on stderr saying how many). The view
shows nothing the plain report doesn't. It never opens in CI, when the output is piped, or in a
window narrower than 60 columns: the plain report is printed instead.

### The launch command

`gaugeline launch --help` prints:

```text title=Output
Usage: gaugeline launch <address> [options]

Run the launch-day checks: links to preview addresses, the share picture, an
indexable staging site, noindex and robots.txt. Read-only.

Options:
      --ci                       Exit 1 when a "Fix this first" finding is found
                                 [CI]
      --json                     Print the result as JSON on stdout, and nothing
                                 else
      --no-open                  Do not open anything in a browser
      --allow-private            Allow addresses on this computer or a private
                                 network, such as 127.0.0.1 or 192.168.x.x
      --allow-secret-key         Use a Stripe secret key, with a notice, instead
                                 of refusing it; a restricted key is safer
      --dns                      Also read the domain's mail records (SPF and
                                 DMARC) from DNS
      --slack <value>            Send a summary to this Slack incoming webhook
                                 (or set GAUGELINE_SLACK_WEBHOOK)
      --discord <value>          Send an embed to this Discord webhook (or set
                                 GAUGELINE_DISCORD_WEBHOOK)
      --webhook <value>          POST the result as JSON to this address (or set
                                 GAUGELINE_WEBHOOK)
      --email <value>            Email the full report to these addresses
                                 through Resend (or set GAUGELINE_EMAIL)
      --notify-on <value>        When to send: any (something was found, the
                                 default), high or always
      --report-url <value>       Link each message to a hosted copy of the
                                 report at this address
      --save-requests <value>    Save the requests made and the page's data to
                                 this JSON file; it may contain page content, so
                                 do not commit it
      --quiet                    Print only results and errors
      --verbose                  Show each request, and technical detail when
                                 something goes wrong
  -h, --help                     Show this help and exit
  -v, --version                  Print the version and exit

Exit codes: 0 ran, 1 --ci with a fix-first finding, 2 could not run
```

### Flags

The table below is generated from `packages/cli/src/flags.ts` (`pnpm docs:flags`). Do not edit
between the markers; CI fails when it differs from the flag table.

<!-- flags:start -->

| Flag                      | Does                                                                                                           | Environment variable | Since |
| ------------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------- | ----- |
| `--ci`                    | Exit 1 when a "Fix this first" finding is found                                                                | `CI`                 | 0.1.0 |
| `--json`                  | Print the result as JSON on stdout, and nothing else                                                           |                      | 0.1.0 |
| `--no-open`               | Do not open anything in a browser                                                                              |                      | 0.1.0 |
| `--demo`                  | Start the app with example results about invented sites; no address is checked and nothing is requested        |                      | 0.2.0 |
| `--ads <value>`           | Start the app with an ads export read from this file (a Meta Ads Manager or Google Ads CSV)                    |                      | 0.2.0 |
| `--allow-private`         | Allow addresses on this computer or a private network, such as 127.0.0.1 or 192.168.x.x                        |                      | 0.1.0 |
| `--allow-secret-key`      | Use a Stripe secret key, with a notice, instead of refusing it; a restricted key is safer                      |                      | 0.2.0 |
| `--dns`                   | Also read the domain's mail records (SPF and DMARC) from DNS                                                   |                      | 0.2.0 |
| `--owner-consent`         | Run the probing checks, which ask routes for what they protect with no login; only on sites you may test       |                      | 0.2.0 |
| `--routes <value>`        | With --owner-consent, find download routes in route files matching this glob (repeatable)                      |                      | 0.2.0 |
| `--since <value>`         | Page check: compare with the last run (the only value is last). delivery: the window to read, such as 7d       |                      | 0.2.0 |
| `--paid`                  | Count the orders paid in Stripe in the window; with --sent, compare them with the emails                       |                      | 0.2.0 |
| `--sent`                  | Count the emails Resend says it sent in the window; with --paid, compare them with the orders                  |                      | 0.2.0 |
| `--webhooks`              | Read Stripe's webhook endpoints and the events that were never delivered                                       |                      | 0.2.0 |
| `-i`, `--interactive`     | Open a terminal view of the results to move through, filter and dismiss findings                               |                      | 0.2.0 |
| `--slack <value>`         | Send a summary to this Slack incoming webhook (or set GAUGELINE_SLACK_WEBHOOK)                                 |                      | 0.2.0 |
| `--discord <value>`       | Send an embed to this Discord webhook (or set GAUGELINE_DISCORD_WEBHOOK)                                       |                      | 0.2.0 |
| `--webhook <value>`       | POST the result as JSON to this address (or set GAUGELINE_WEBHOOK)                                             |                      | 0.2.0 |
| `--email <value>`         | Email the full report to these addresses through Resend (or set GAUGELINE_EMAIL)                               |                      | 0.2.0 |
| `--plan-only`             | Check the plan on its own, before anything is built (no requests)                                              |                      | 0.2.0 |
| `--sheet <value>`         | Read this tab of a workbook instead of the one with a URL column                                               |                      | 0.2.0 |
| `--legacy-from <value>`   | Read old addresses from this notes column when the plan has no Legacy URL column (repeatable)                  |                      | 0.2.0 |
| `--legacy-review <value>` | Write the old addresses read with --legacy-from to this CSV file, for review                                   |                      | 0.2.0 |
| `--base <value>`          | Check the plan against the site built at this address, such as a preview                                       |                      | 0.2.0 |
| `--annotate <value>`      | Write a copy of the plan with a Gaugeline column saying what is wrong on each row                              |                      | 0.2.0 |
| `--force`                 | Let --annotate replace a file that already exists                                                              |                      | 0.2.0 |
| `--progress <value>`      | With --base, say what was fixed and what is new since the last run (state file optional)                       |                      | 0.2.0 |
| `--watch <value>`         | With --base on production: the 30-day watch from this cutover date (YYYY-MM-DD)                                |                      | 0.2.0 |
| `--all`                   | plan --progress: list the findings still open; run: check every site in gaugeline.sites.json                   |                      | 0.2.0 |
| `--live <value>`          | List pages in this crawl, sitemap, Search Console export or list that the plan misses                          |                      | 0.2.0 |
| `--nav <value>`           | Check the menu tabs (all headed Main category, or these, comma separated) against the pages                    |                      | 0.2.0 |
| `--rank <value>`          | With --live, sort the missing pages by clicks from this Search Console or rank export                          |                      | 0.2.0 |
| `--ignore <value>`        | With --live, leave out paths matching this glob, such as /tag/* (repeatable)                                   |                      | 0.2.0 |
| `--printed <value>`       | With --base, add the printed register's addresses to the 301 map                                               |                      | 0.2.0 |
| `--decode <value>`        | Read the QR code in these PNG images (or a folder) and add new ones to the register                            |                      | 0.2.0 |
| `--tags <value>`          | Query parameters that must reach the destination, as name prefixes (default utm_)                              |                      | 0.2.0 |
| `--site <value>`          | Check this site from gaugeline.sites.json, by name (repeatable)                                                |                      | 0.2.0 |
| `--tag <value>`           | Check the sites in gaugeline.sites.json with this tag, such as client                                          |                      | 0.2.0 |
| `--parallel <value>`      | Check this many sites at once (default 1); sites on one host never overlap                                     |                      | 0.2.0 |
| `--limit <value>`         | Re-check this many of the export's pages (default 40; 0 only classifies the rows)                              |                      | 0.2.0 |
| `--out <value>`           | Where to write the snapshot (default before.json)                                                              |                      | 0.2.0 |
| `--before <value>`        | The snapshot taken before cutover, written by gaugeline snapshot                                               |                      | 0.2.0 |
| `--runs <value>`          | The folder of saved runs (each one saved with --json) to read                                                  |                      | 0.2.0 |
| `--time-zone <value>`     | The time zone for dates and ages, such as America/Los_Angeles (default UTC)                                    |                      | 0.2.0 |
| `--notify-on <value>`     | When to send: any (something was found, the default), high or always                                           |                      | 0.2.0 |
| `--report-url <value>`    | Link each message to a hosted copy of the report at this address                                               |                      | 0.2.0 |
| `--save-requests <value>` | Save the requests made and the page's data to this JSON file; it may contain page content, so do not commit it |                      | 0.2.0 |
| `--list`                  | Print the data assertions in gaugeline.sources.json and run none of them                                       |                      | 0.2.0 |
| `--quiet`                 | Print only results and errors                                                                                  |                      | 0.1.0 |
| `--verbose`               | Show each request, and technical detail when something goes wrong                                              |                      | 0.1.0 |
| `-h`, `--help`            | Show this help and exit                                                                                        |                      | 0.1.0 |
| `-v`, `--version`         | Print the version and exit                                                                                     |                      | 0.1.0 |

<!-- flags:end -->

Only "Fix this first" findings fail CI. "Fix soon" and "Worth knowing" never change the exit code.

### Streams and colour

Results go to stdout; progress, warnings and errors go to stderr, so `--json` output can be piped
straight into another program. Colour is used only when stdout is a terminal, and never when
`NO_COLOR` is set. `FORCE_COLOR=1` turns it on for a pipe.

`--quiet` and `--verbose` together is refused: "Choose --quiet or --verbose, not both." (exit 2).

### JSON output

`--json` prints one object on stdout. Its shape is published as a JSON Schema file,
[`packages/core/schema/result.v2.json`](https://github.com/alvinwquach/gaugeline/blob/main/packages/core/schema/result.v2.json) (draft 2020-12),
that scripts can validate against:

```json
{
  "schema": 2,
  "url": "https://shop.example/",
  "startedAt": "2026-01-02T03:04:05.000Z",
  "findings": [],
  "passed": ["title-missing"],
  "failed": [],
  "couldNotCheck": [],
  "sampled": { "links": { "seen": 0, "taken": 0, "limit": 30 } }
}
```

- `passed` and `failed` are check ids. `failed` lists checks that could not execute; the rest of the
  run still reports.
- `sampled` has every kind the run samples (links, images, sitemap pages, ...), zeros included:
  `{ seen, taken, limit }`. Schema 2 added it with `couldNotCheck`.
- `couldNotCheck` lists what a check could not read because the site refused it (401, 403, 429,
  503 with Retry-After, or a bot challenge page): `{ id, reason, url }`. It is never a finding, and
  a check with an entry is never in `passed`. Schema 2 added it; schema 1 had no such field.
- Unknown keys are not allowed, so a misspelt field fails validation.
- The `schema` number only changes with a new file. Published files (`result.v1.json`,
  `result.v2.json`) are never edited in place; a new
  shape ships as `result.v2.json` and the old file stays in the package so consumers can pin.

### Saving the requests

`--save-requests <file>` writes the addresses a check requested and the page's data to a separate JSON
file. It is off by default, and `--json` is the same with or without it (schema 2). It works with the
page check (`gaugeline <address>`) and `gaugeline launch`; every other command refuses it with exit
code 2. The file may contain page content, so do not commit it. What is in it, how it is redacted and
cut to a size limit, when it can fail and how its own versioned schema will change are on
[Privacy and safety](privacy.md#saving-the-requests-save-requests).

### The delivery and platform commands

Two commands read accounts you own instead of a site. Neither takes an address, and both are read only:
every request is a `GET`, the keys come from the environment and never reach a log, a finding or a
report, and what is printed is counts, hosts and days, never a name, an address, an order or a payload.

```sh
npx gaugeline delivery --paid --sent --since 7d
npx gaugeline platform --webhooks
```

- `gaugeline delivery --paid --sent [--since 7d]` counts the orders paid in Stripe (`STRIPE_API_KEY`)
  and the emails Resend says it sent (`RESEND_API_KEY`) in the window, and reports paid orders with no
  email (`delivery-receipt-missing`). Either flag alone prints that side's count. `--since` takes `7d`
  (the default), `24h` or a date such as `2026-11-01`, and anything else is exit 2. The page check's
  `--since last` is a different use of the same flag and is only for the page check.
- `gaugeline platform --webhooks` reads Stripe's webhook endpoints and the events that were never
  delivered, and reports an enabled endpoint with events older than an hour still waiting
  (`webhook-failing`) and a disabled endpoint (`webhook-disabled`).
- Both take `--json` (the schema 2 result and nothing else), `--ci` (exit 1 for a "Fix this first"
  finding) and `--allow-secret-key`. A missing or refused key is exit 2 and names the variable.

What they read, what keys to make, and how the match is made: [Paid downloads and
delivery](delivery.md#paid-and-the-receipt-never-went-out). What they send:
[Privacy and safety](privacy.md#orders-emails-and-webhooks-delivery-and-platform).

### The query command

`gaugeline query <folder>` reads the GROQ in a repository instead of checking a site. It takes one folder and reads files. For every query it finds (`groq` tagged templates and `defineQuery()` calls in `.ts`, `.tsx`, `.js`, `.jsx` and `.mjs` files) it prints the document type, the fields the query reads, whether its filter leaves drafts out, its parameters, and the file and line it starts on. A query built at run time, a file that does not parse and a query with no `_type` filter are listed as unreadable, never skipped.

```sh
npx gaugeline query ./src
```

With `SANITY_PROJECT_ID` set (and `SANITY_DATASET`, `production` when unset, and `SANITY_TOKEN` with the Viewer role for a private dataset) it also asks the dataset for counts, one `GET` for each document type, and reports a field no document has (`query-field-absent`), a type with no documents (`query-type-empty`), a field some documents lack (`query-field-partial`) and a query whose filter leaves drafts out (`query-no-drafts-filter`). Counts only: no document is ever read. Without `SANITY_PROJECT_ID` it makes no request, needs no token and says so on stderr.

It takes `--json` (the schema 2 result and nothing else; it needs `SANITY_PROJECT_ID`) and `--ci` (exit 1 for a "Fix this first" finding). It exits 0 when it read the folder and 2 when the folder does not exist, TypeScript is not installed beside it (`npx -p gaugeline -p typescript gaugeline query ./src` brings it) or the dataset could not be read: a private dataset with no token names `SANITY_TOKEN` and the Viewer role. What it reads and what it lists as unreadable: [Checking your queries](query-check.md#what-the-command-reads); what it counts: [What it reports](query-check.md#what-it-reports).

### Probing checks (--owner-consent and --routes)

Most checks read what any visitor can read. A **probing** check asks something that should be protected
for what it protects, with no login: it is the one kind of request that could be unwelcome on a site
that is not yours. Probing checks are off by default and run only with `--owner-consent`, or with a
`gaugeline.consent.json` in the folder you run from. **Run them only on sites you own or have permission
to test.** Without either, nothing is asked and the check is not listed.

```json title=gaugeline.consent.json
{
  "ownerConsent": {
    "by": "Maya Ortiz, owner of Tideline Coaching",
    "on": "2026-11-10"
  }
}
```

`by` says who agreed and `on` says when, so a shared repository records it once. A run with consent
prints one line on stderr saying probing checks are on.

The one probing check today is `gated-download-open`, described in
[Paid downloads and delivery](delivery.md#a-download-route-that-hands-the-file-to-anyone).

`--routes <glob>` (repeatable) points that check at your repository's route files, so it finds routes
no page links to. Run Gaugeline from the repository's folder and give a glob such as
`app/api/**/route.ts` (the app router) or `pages/api/**/*.ts` (the pages router); each matching file
name is turned into the address it serves (`app/api/download/[id]/route.ts` becomes
`/api/download/[id]`). Only file names are read: no source file is opened. A route whose path does not
contain download, file, deliver or export is never asked. A dynamic route is asked only for an address
a link on the page gave, and ids are never guessed. `--routes` without `--owner-consent` is refused
with exit 2.

```sh
npx gaugeline tideline-coaching.example --owner-consent --routes "app/api/**/route.ts" --ci
```

What the probe sends and reads is on [Privacy and safety](privacy.md#download-routes-a-probing-check).

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
| `--upload`                                     | Upload the result to your hosted workspace after the run. See [Hosted: the runs API](/docs/hosted/api#upload-from-the-command-line)            |

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
gaugeline check <folder> --routes --base <address> --owner-consent reads the
Next.js routes in a folder and asks the running site for each signed-in one with
no session (a probing check: only on sites you own or have permission to test).

Options:
      --ci                         Exit 1 when a "Fix this first" finding is
                                   found [CI]
      --json                       Print the result as JSON on stdout, and
                                   nothing else
      --format <value>             What stdout carries: json (as --json), sarif,
                                   junit or one-pager (a cited page; view reads
                                   a saved run)
      --json-schema <value>        With --json: the result schema to print, 2
                                   (the default) or 3 (also lists what
                                   suppressions and the baseline hide)
      --no-open                    Do not open anything in a browser
      --allow-private              Allow addresses on this computer or a private
                                   network, such as 127.0.0.1 or 192.168.x.x
      --allow-secret-key           Use a Stripe secret key, with a notice,
                                   instead of refusing it; a restricted key is
                                   safer
      --dns                        Also read the domain's mail records (SPF and
                                   DMARC) from DNS
      --renewals                   Also check what lapses: the domain's
                                   registration, the certificates and any token
                                   you set up
      --cost                       Also check what runs up the hosting bill:
                                   pages that change on every visit, the cache
                                   and usage jumps
      --trackers                   Also list the trackers on pages with a form
                                   or a path you listed, and what a tag manager
                                   holds
      --renderer <value>           Also load the page in a browser you installed
                                   (playwright), to read what scripts add; never
                                   downloads one
      --pagespeed                  Also read Google's PageSpeed Insights:
                                   real-user vitals decide, lab is advice; sends
                                   page addresses to Google
      --attribution                With --renderer: reload the page without
                                   motion, scripts or third parties and say
                                   which moves load time
      --libraries                  Also check the JavaScript files a page loads
                                   for libraries with a published advisory
      --wordpress                  Also check a WordPress site's versions
                                   against the current releases, and whether it
                                   lists its users
      --backups                    Also check when the client's content and
                                   database were last backed up (Supabase,
                                   Sanity, an export folder)
      --published                  Also check that content changed in your CMS
                                   is live on the site, and that unpublished
                                   pages are gone
      --owner-consent              Run the probing checks, which ask routes for
                                   what they protect with no login; only on
                                   sites you may test
      --routes <value>             With --owner-consent: download routes in
                                   files matching this glob (repeatable); no
                                   glob: a folder's signed-in routes
      --since <value>              Page check: compare with the last run (the
                                   only value is last). delivery: the window to
                                   read, such as 7d
  -i, --interactive                Open a terminal view of the results to move
                                   through, filter and dismiss findings
      --slack <value>              Send a summary to this Slack incoming webhook
                                   (or set GAUGELINE_SLACK_WEBHOOK)
      --discord <value>            Send an embed to this Discord webhook (or set
                                   GAUGELINE_DISCORD_WEBHOOK)
      --webhook <value>            POST the result as JSON to this address (or
                                   set GAUGELINE_WEBHOOK)
      --email <value>              Email the full report to these addresses
                                   through Resend (or set GAUGELINE_EMAIL)
      --base <value>               The site a plan is checked against (a
                                   preview); the site emails link to; or the
                                   site to ask for --routes
      --notify-on <value>          When to send: any (something was found, the
                                   default), high or always
      --report-url <value>         Link each message to a hosted copy of the
                                   report at this address
      --upload                     Upload the result to your hosted workspace;
                                   needs GAUGELINE_TOKEN and
                                   GAUGELINE_UPLOAD_URL (see the API page)
      --save-requests <value>      Save the requests made and the page's data to
                                   this JSON file; it may contain page content,
                                   so do not commit it
      --baseline <value>           Read or write a file of known findings; with
                                   it a run reports only new ones
      --update-baseline            With --baseline, write the file again from
                                   this run
      --config-json-only           Refuse a gaugeline.config.mjs, .js or .ts,
                                   which runs code; read gaugeline.config.json
                                   only [GAUGELINE_NO_EXEC_CONFIG]
      --suppress <value>           Snooze a check id for this run, with an
                                   expiry and a reason (repeatable)
      --suppress-until <value>     With --suppress, the last day it applies,
                                   YYYY-MM-DD; a past date is refused
      --suppress-reason <value>    With --suppress, why the finding is accepted
                                   for now
      --quiet                      Print only results and errors
      --verbose                    Show each request, and technical detail when
                                   something goes wrong
  -h, --help                       Show this help and exit
  -v, --version                    Print the version and exit

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
- `script-changed`, `csp-loosened` and `security-header-loosened`: a third-party script is new or lost
  its integrity attribute, the Content-Security-Policy allows more, or another security header is
  gone or weaker (see [Script and header baseline](/docs/guides/script-baseline)).

The run is saved in `.gaugeline/last-run/<host>.json` in the folder you run from: hosts, amounts and
provider names, word counts, headings, item addresses, third-party script hosts and paths and security header directives only, never form values, page text or keys. Without `--since` nothing is read or
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
      --ci                         Exit 1 when a "Fix this first" finding is
                                   found [CI]
      --json                       Print the result as JSON on stdout, and
                                   nothing else
      --format <value>             What stdout carries: json (as --json), sarif,
                                   junit or one-pager (a cited page; view reads
                                   a saved run)
      --json-schema <value>        With --json: the result schema to print, 2
                                   (the default) or 3 (also lists what
                                   suppressions and the baseline hide)
      --no-open                    Do not open anything in a browser
      --allow-private              Allow addresses on this computer or a private
                                   network, such as 127.0.0.1 or 192.168.x.x
      --allow-secret-key           Use a Stripe secret key, with a notice,
                                   instead of refusing it; a restricted key is
                                   safer
      --dns                        Also read the domain's mail records (SPF and
                                   DMARC) from DNS
      --slack <value>              Send a summary to this Slack incoming webhook
                                   (or set GAUGELINE_SLACK_WEBHOOK)
      --discord <value>            Send an embed to this Discord webhook (or set
                                   GAUGELINE_DISCORD_WEBHOOK)
      --webhook <value>            POST the result as JSON to this address (or
                                   set GAUGELINE_WEBHOOK)
      --email <value>              Email the full report to these addresses
                                   through Resend (or set GAUGELINE_EMAIL)
      --notify-on <value>          When to send: any (something was found, the
                                   default), high or always
      --report-url <value>         Link each message to a hosted copy of the
                                   report at this address
      --upload                     Upload the result to your hosted workspace;
                                   needs GAUGELINE_TOKEN and
                                   GAUGELINE_UPLOAD_URL (see the API page)
      --save-requests <value>      Save the requests made and the page's data to
                                   this JSON file; it may contain page content,
                                   so do not commit it
      --baseline <value>           Read or write a file of known findings; with
                                   it a run reports only new ones
      --update-baseline            With --baseline, write the file again from
                                   this run
      --config-json-only           Refuse a gaugeline.config.mjs, .js or .ts,
                                   which runs code; read gaugeline.config.json
                                   only [GAUGELINE_NO_EXEC_CONFIG]
      --suppress <value>           Snooze a check id for this run, with an
                                   expiry and a reason (repeatable)
      --suppress-until <value>     With --suppress, the last day it applies,
                                   YYYY-MM-DD; a past date is refused
      --suppress-reason <value>    With --suppress, why the finding is accepted
                                   for now
      --quiet                      Print only results and errors
      --verbose                    Show each request, and technical detail when
                                   something goes wrong
  -h, --help                       Show this help and exit
  -v, --version                    Print the version and exit

Exit codes: 0 ran, 1 --ci with a fix-first finding, 2 could not run
```

### The brief command

`gaugeline brief --help` prints:

```text title=Output
Usage: gaugeline brief <address> [options]

Check the site, then write a work order in plain English: how many items are
worth paying to fix and how big each is (Small 1 point, Medium 3, Large 8),
then each item with what is wrong, why it matters, what done looks like, the
evidence and what changes the estimate. With --hours-per-point it adds a range
of hours (never one number), and with --rate the range in money. It prints the
Markdown, or writes it to --out inside this folder, never over a file that is
there unless --force. Read-only: it checks the site exactly as the page check.

Options:
      --allow-private              Allow addresses on this computer or a private
                                   network, such as 127.0.0.1 or 192.168.x.x
      --allow-secret-key           Use a Stripe secret key, with a notice,
                                   instead of refusing it; a restricted key is
                                   safer
      --dns                        Also read the domain's mail records (SPF and
                                   DMARC) from DNS
      --owner-consent              Run the probing checks, which ask routes for
                                   what they protect with no login; only on
                                   sites you may test
      --force                      Let --annotate (plan), --page, --save
                                   (query), --out (brief), handoff or audit
                                   replace files, never a folder or link
      --out <value>                snapshot: the file (default before.json).
                                   query --page: the folder. brief: the file.
                                   handoff, audit: the folder
      --business <value>           brief: the business the work order is for,
                                   shown in its heading. audit: the prospect's
                                   business
      --rate <value>               brief: what an hour costs, in whole currency
                                   units such as 110; used with
                                   --hours-per-point
      --hours-per-point <value>    brief: how many hours one point takes, such
                                   as 1.5; prints a range of hours, never one
                                   number
      --quiet                      Print only results and errors
      --verbose                    Show each request, and technical detail when
                                   something goes wrong
  -h, --help                       Show this help and exit
  -v, --version                    Print the version and exit

Exit codes: 0 wrote the work order, 2 could not run
```

`gaugeline brief <address>` checks the site the way the page check does and writes a work order in
Markdown: the items worth paying to fix, each sized Small (1 point), Medium (3) or Large (8), with what
is wrong, why it matters, what done looks like, the evidence and what changes the estimate. It prints
the work order, or writes it to `--out` (a file in the folder you run from; never over a file that is
there without `--force`, never outside the folder, and all of it or nothing). `--rate` is in whole
currency units and is stored as minor units (`--rate 110` is 11000). `--rate` without
`--hours-per-point` gives points only, and says so on stderr. Exit codes: 0 when it ran, whatever it found,
and 2 when it could not run. See [When you don't have a developer](/docs/no-developer).

### The audit command

`gaugeline audit --help` prints:

```text title=Output
Usage: gaugeline audit <address> --pack [options]

Check a prospect's site, then write a proposal-ready pack into a folder (default
gaugeline-audit): audit-pack.html to send or print, audit-pack.md to edit. A
one-page summary for the owner (what is at risk, the five findings to start
with, with evidence), the findings grouped into your packages from
gaugeline.services.json with your own price and hours ranges and what each
leaves out, how you would check each worked (the re-run), and what the audit
does not include. Without that file the findings are grouped by area and there
is no estimate: Gaugeline never makes up a price. It runs only the default
checks, which look at public pages; the probing checks run only with
--owner-consent, on a site you may test. Nothing is sent: the files stay in
this folder, never replacing a file unless --force. Read-only, like the page
check.

Options:
      --allow-private            Allow addresses on this computer or a private
                                 network, such as 127.0.0.1 or 192.168.x.x
      --allow-secret-key         Use a Stripe secret key, with a notice, instead
                                 of refusing it; a restricted key is safer
      --dns                      Also read the domain's mail records (SPF and
                                 DMARC) from DNS
      --owner-consent            Run the probing checks, which ask routes for
                                 what they protect with no login; only on sites
                                 you may test
      --force                    Let --annotate (plan), --page, --save (query),
                                 --out (brief), handoff or audit replace files,
                                 never a folder or link
      --out <value>              snapshot: the file (default before.json). query
                                 --page: the folder. brief: the file. handoff,
                                 audit: the folder
      --business <value>         brief: the business the work order is for,
                                 shown in its heading. audit: the prospect's
                                 business
      --pack                     audit: turn the run into a proposal-ready pack
                                 (HTML and Markdown), using the packages in
                                 gaugeline.services.json
      --brand <value>            audit: your name, shown at the head and foot of
                                 the pack
      --brand-logo <value>       audit: an https address for your logo; it is
                                 never fetched by Gaugeline, only by whoever
                                 opens the pack
      --brand-contact <value>    audit: your contact line, shown under your name
      --quiet                    Print only results and errors
      --verbose                  Show each request, and technical detail when
                                 something goes wrong
  -h, --help                     Show this help and exit
  -v, --version                  Print the version and exit

Exit codes: 0 wrote the pack, 2 could not run
```

`gaugeline audit <address> --pack` checks a prospect's site the way the page check does and turns the run
into a proposal-ready pack: `audit-pack.html` to send or print and `audit-pack.md` to edit, in the folder
`--out` names (`gaugeline-audit` when you leave it out, inside the folder you ran from; never over a file
without `--force`, and both files or neither). The pack has a one-page summary for the owner, the findings
grouped into the packages in `gaugeline.services.json` with your own price and hours ranges, what each
package leaves out, and how you would check it worked. Without that file the findings are grouped by area
and the pack shows no estimate: prices come only from your file. `--brand`, `--brand-logo` and
`--brand-contact` say who the pack is from. It runs only the default checks; the probing checks run only
with `--owner-consent`, on a site you own or have permission to test. A package that names a check
Gaugeline does not run, a folder outside this one and a pack that is already there without `--force` are
exit 2, before anything is requested. Settings, an example from a bar and one from a bakery:
[Audit pack](guides/audit-pack.md). What it sends: [Privacy and safety](privacy.md#audit-pack-gaugeline-audit-pack).

### The migration command

`gaugeline migration --help` prints:

```text title=Output
Usage: gaugeline migration <address> (--old <site> | --old-file <file>)

Moving a site? Read the old site's list of pages (its WordPress API, an export
from Wix or Webflow, or its sitemap) and check that each one exists on the new
site, redirects in one hop, and keeps its title, canonical and structured data
type. Read only: GET requests, up to 500 pages. The list is data; nothing in
it is run.

Options:
      --ci                  Exit 1 when a "Fix this first" finding is found [CI]
      --allow-private       Allow addresses on this computer or a private
                            network, such as 127.0.0.1 or 192.168.x.x
      --old <value>         migration: the old site's address, to read its list
                            of pages and the pages themselves
      --old-file <value>    migration: a Wix, Webflow or other export (CSV or
                            JSON) that lists the old site's pages, read from
                            this file
      --quiet               Print only results and errors
      --verbose             Show each request, and technical detail when
                            something goes wrong
  -h, --help                Show this help and exit
  -v, --version             Print the version and exit

Exit codes: 0 ran, 1 --ci and a fix-first finding, 2 could not run or read
```

`gaugeline migration <new-address>` is for a site that is moving platform. It reads the old site's list of
published pages, from its WordPress REST API (`--old`, the old site's address), from an export you saved
from Wix or Webflow (`--old-file`, a CSV or JSON file read from this computer), or from the old site's
sitemap, and checks each one on the new site: it exists, it gets there in one redirect, and it keeps its
title, its canonical and its structured data types. `--ci` exits 1 when a page is missing. A page the new
site would not give (a 503, a password, a timeout) is exit 2, never a quiet pass. Up to 500 pages, each one
GET, nothing else. The old site's list is data: titles and addresses in it are compared and printed as
text. Settings, an example from a bakery and what each check means:
[Migration completeness](guides/migration.md). What it sends:
[Privacy and safety](privacy.md#migration-completeness-gaugeline-migration).

### The advisory command

`gaugeline advisory --help` prints:

```text title=Output
Usage: gaugeline advisory <site> <advisory-id | package@range> [options]

A client asks "are we affected?" the day an advisory is announced. Give the
site and a CVE or GHSA id (read from OSV, with one GET of api.osv.dev) or a
package and affected versions. Answers likely-affected, likely-not-affected or
cannot-tell, from outside only, with the evidence and what to check inside.
Read only: GET requests; --dns also reads the name servers. It never says a
site is safe.

Options:
      --ci                 Exit 1 when a "Fix this first" finding is found [CI]
      --json               Print the result as JSON on stdout, and nothing else
      --allow-private      Allow addresses on this computer or a private
                           network, such as 127.0.0.1 or 192.168.x.x
      --dns                Also read the domain's mail records (SPF and DMARC)
                           from DNS
      --package <value>    advisory: a package@range to use instead of looking
                           the id up in OSV (repeatable)
      --host <value>       advisory: another hostname of the client to look at,
                           such as an old subdomain (up to 5)
      --note               advisory: print the short note for the client
                           (Markdown) instead of the report
      --quiet              Print only results and errors
      --verbose            Show each request, and technical detail when
                           something goes wrong
  -h, --help               Show this help and exit
  -v, --version            Print the version and exit

Exit codes: 0 ran, 1 --ci and likely-affected, 2 could not run
```

`gaugeline advisory <site> <advisory-id | package@range>` answers "is my client affected?" the day an advisory
is announced, from outside only. An id (CVE or GHSA) is read from OSV with one `GET` of `api.osv.dev`; a
package and its affected versions (`"next@>=15.0.0 <15.2.3"`) need no request to OSV, and `--package` gives
the ranges for an id when OSV cannot be reached. It reads the site's home page, its `www` twin, the
hostnames you give with `--host` and a few linked subdomains, each with `GET`, and answers
`likely-affected`, `likely-not-affected` or `cannot-tell` with the evidence, what to check inside and a
note for the client (`--note`). It never says a site is safe. `--json` has its own schema (`advisory.v1.json`),
and `--ci` exits 1 on `likely-affected`. An example from a pop-up bar, one from a clinic and one from a
roaster behind a CDN: [Advisory check](guides/advisory.md). What it sends:
[Privacy and safety](privacy.md#advisory-check-gaugeline-advisory).

### The init command

`gaugeline init --help` prints:

```text title=Output
Usage: gaugeline init <site> [options]

Point Gaugeline at a client's site and get starter settings for what it is
built on. Reads the home page and up to four pages it links to (GET only), and
recognises the content system, framework, host, forms, payment links, analytics
and listing links from what the pages show. Writes gaugeline.adapters.json and
the other settings files it can fill in, plus gaugeline.init.md with the
evidence for each setting, and prints what to set up next. It never writes a
key: it names the environment variables you set. A file that already exists is
left alone unless you add --force; --dry-run prints everything and writes
nothing.

Options:
      --allow-private    Allow addresses on this computer or a private network,
                         such as 127.0.0.1 or 192.168.x.x
      --dns              Also read the domain's mail records (SPF and DMARC)
                         from DNS
      --force            Let --annotate (plan), --page, --save (query), --out
                         (brief), handoff or audit replace files, never a folder
                         or link
      --dry-run          init: print the settings files it would write, and
                         write nothing
      --quiet            Print only results and errors
      --verbose          Show each request, and technical detail when something
                         goes wrong
  -h, --help             Show this help and exit
  -v, --version          Print the version and exit

Exit codes: 0 ran, 2 could not run
```

`gaugeline init <site>` reads the home page and up to four pages it links to, with `GET` only, and writes
starter settings for what the site is built on, so setup starts from what is already there. It never
writes a key, never replaces a file that exists unless you add `--force`, and writes only inside the folder
you ran it in. `--dry-run` prints the files and writes nothing. An example from a pop-up bar on WordPress
with a Formspree form: [gaugeline init](guides/init.md).

### The changes command

`gaugeline changes --help` prints:

```text title=Output
Usage: gaugeline changes <site> [--since <date|run-id>] [--before-after]

For each finding that is new since the run before (or since a date or run id),
show what changed on the page and what the records say changed it: a content
edit in the content system (with the editor's name as it shows it), a deploy on
Vercel or Netlify (with the commit range), both, or unknown. The label is
evidence, never a verdict. Reads the runs that --since last saves in
.gaugeline/runs, and GETs the content system's history and the host's
deployment list when gaugeline.changes.json names them. Read only; never
guesses an author. For this command --since takes a date such as 2026-11-01
or a run id such as r-20261101T100000Z. With --before-after it instead prints
the findings of two saved runs side by side (fixed, new, still there) and
makes no request.

Options:
      --json             Print the result as JSON on stdout, and nothing else
      --since <value>    Findings that appeared after this date (2026-11-01) or
                         run id (r-20261101T100000Z)
      --before-after     Print two saved runs side by side: fixed, new and still
                         there (--since names the before run)
      --quiet            Print only results and errors
      --verbose          Show each request, and technical detail when something
                         goes wrong
  -h, --help             Show this help and exit
  -v, --version          Print the version and exit

Exit codes: 0 ran, 2 could not run
```

`gaugeline changes <site>` lists the findings that are new since the run before, or since a date or run id, and for each
what changed on the page and what the content system's history and the host's deployments say about when. It reads the
runs that `--since last` saves and, only when `gaugeline.changes.json` names them, makes `GET` requests to Sanity's history
and to Vercel or Netlify. The label is evidence, never a verdict. With `--before-after` it instead prints the findings of
two saved runs side by side (fixed, new, still there) and makes no request. An example from a pop-up bar:
[What changed, and who changed it](guides/what-changed.md).

### The receipt command

`gaugeline receipt --help` prints:

```text title=Output
Usage: gaugeline receipt <site> [--month <yyyy-mm>] [options]

What Gaugeline caught for a site in a month, for a care-plan client: the
findings that opened and were fixed, with the day each was first seen and the
day it was fixed, in plain groups (booking and payments, listings and hours,
site and content, renewals, security signals). A fix is 'before your customers
did' unless you mark it --client-reported, and then it is listed as 'fixed after
you told us'. It restates the runs that --since last saves in .gaugeline/runs:
it never estimates money or traffic and reads nothing else, except with
--coming-up, which also reads the domain's registration and the certificates
(GET only) for what lapses in the next 60 days. Prints Markdown, --json, or one
printable page with --printable. Read only; it writes no file.

Options:
      --json                       Print the result as JSON on stdout, and
                                   nothing else
      --coming-up                  Also read what lapses in the next 60 days
                                   (domain, certificates, tokens) for Coming up
      --month <value>              The month a receipt covers, as yyyy-mm in UTC
                                   (default: the last whole month)
      --client-reported <value>    A fix your client reported first, as a check
                                   id with an optional page
                                   (payment-link-dead@/visit); repeatable
      --printable                  Print the receipt as one page to print or
                                   save as a PDF, instead of Markdown
      --quiet                      Print only results and errors
      --verbose                    Show each request, and technical detail when
                                   something goes wrong
  -h, --help                       Show this help and exit
  -v, --version                    Print the version and exit

Exit codes: 0 ran, 2 could not run
```

`gaugeline receipt <site>` counts the findings that were opened and fixed in a month from the runs that `--since last`
saves, and prints them in plain groups with the dates, ready for a care-plan client. It writes no file. Only
`--coming-up` asks anything, and only what `gaugeline renewals` asks, with `GET` and `HEAD`. It never estimates money or
traffic. See [The care-plan receipt](guides/care-plan-receipt.md).

### The deploy-gate command

`gaugeline deploy-gate --help` prints:

```text title=Output
Usage: gaugeline deploy-gate [<address>] [options]

Check a preview deployment on Vercel, Netlify or Cloudflare Pages before it
goes to production. Type the preview's address, or leave it out and Gaugeline
reads it from the host's environment (VERCEL_URL, DEPLOY_PRIME_URL,
CF_PAGES_URL). It refuses to run when the environment says production. Runs the
normal checks (GET only; probing checks stay off without --owner-consent) and
ends with one line: gate: clear, or gate: would block. Report only: the exit
code stays 0 until you add --block.

Options:
      --json              Print the result as JSON on stdout, and nothing else
      --format <value>    What stdout carries: json (as --json), sarif, junit or
                          one-pager (a cited page; view reads a saved run)
      --allow-private     Allow addresses on this computer or a private network,
                          such as 127.0.0.1 or 192.168.x.x
      --dns               Also read the domain's mail records (SPF and DMARC)
                          from DNS
      --owner-consent     Run the probing checks, which ask routes for what they
                          protect with no login; only on sites you may test
      --block             deploy-gate: exit 1 when a "Fix this first" finding is
                          found; without it the gate only reports
                          [GAUGELINE_GATE_BLOCK]
      --quiet             Print only results and errors
      --verbose           Show each request, and technical detail when something
                          goes wrong
  -h, --help              Show this help and exit
  -v, --version           Print the version and exit

Exit codes: 0 ran, 1 --block and a fix-first finding, 2 could not run
```

`gaugeline deploy-gate` checks a preview deployment on Vercel, Netlify or Cloudflare Pages before it goes to
production. It is the normal check on the preview's address, with `GET` and `HEAD` only, and it ends with one
line, `gate: clear` or `gate: would block`. It only reports until you add `--block` (or set
`GAUGELINE_GATE_BLOCK`): the exit code is 0 unless the run could not finish. The `CI` variable does not turn
blocking on, and `--ci` is not accepted here. It refuses to run, with exit 2, when the host's variables say the
deployment is production. Probing checks stay off unless `--owner-consent` is on the command line. Per-host
snippets and an example from a dentist's Netlify preview: [Deploy gates](guides/deploy-gates.md).

### The propose command

`gaugeline propose --help` prints:

```text title=Output
Usage: gaugeline propose --fixes --repo <folder> [<run.json>] [options]

Turn findings that live in your code into proposals: a unified diff, the finding
it answers, the file it changes and how it is checked again. Three fixers: a
missing redirect (Netlify _redirects or vercel.json) from --plan and --base, a
structured-data value that disagrees with the page, and a lazy or late first
large image, both from a saved run (gaugeline <address> --json > run.json). A
fixer that is not certain makes no proposal and says why. Off by default: add
--fixes (or GAUGELINE_FIXES=1).
It reads the folder and sends GET requests to --base; it changes nothing and
sends nothing: the diffs are printed and written to --out. --to-inbox also
writes each one as the hosted inbox's pull-request draft; a person approves it.

Options:
      --allow-private         Allow addresses on this computer or a private
                              network, such as 127.0.0.1 or 192.168.x.x
      --base <value>          The site a plan is checked against (a preview);
                              the site emails link to; or the site to ask for
                              --routes
      --out <value>           The proposals file (default
                              gaugeline.proposals.json)
      --fixes                 propose: turn fix proposals on (they are off by
                              default); nothing is sent, the diffs are written
                              to a file [GAUGELINE_FIXES]
      --repo <value>          propose: the project's folder on this computer (a
                              checkout of its repository)
      --plan <value>          propose: the launch plan (CSV); with --base, each
                              old address that does not redirect gets a proposal
      --to-inbox <value>      propose: also write each proposal as the hosted
                              inbox's pull-request draft (JSON) to this file
      --repository <value>    propose: the repository's name on GitHub
                              (owner/name), written into each proposal; optional
      --quiet                 Print only results and errors
      --verbose               Show each request, and technical detail when
                              something goes wrong
  -h, --help                  Show this help and exit
  -v, --version               Print the version and exit

Exit codes: 0 ran, 2 could not run
```

`gaugeline propose` turns a finding that lives in your code into a proposal: a unified diff, the finding it
answers and how it is checked again. It is off until `--fixes` (or `GAUGELINE_FIXES`). It reads your project's
folder and, with `--plan` and `--base`, sends `GET` requests to the preview; it changes nothing and sends
nothing, and writes the proposals to `--out`. A fixer that is not certain makes no proposal and says why. An
example from a bookshop's redirect file: [Fix proposals](guides/fix-proposals.md).

### The source command

`gaugeline source --help` prints:

```text title=Output
Usage: gaugeline source <folder> [options]

Read a site's source folder (a Next.js app router project) and run the checks
that look at code, not at a page: what the project says about search (a page's
robots setting that replaces the layout's noindex, a sitemap on a site set to
stay out of search, robots.txt blocking a page that carries noindex, an
indexing switch that accepts more than true, a noindex test that skips
production), the Sanity publish webhook and cache, and tokens and webhook
addresses in code. It reads files and nothing else: it makes no request, runs
no code, never follows a link out of the folder, and never opens .env or other
secret-looking files. A check that cannot tell says so; it never passes. Name
the checks to run with --only.

Options:
      --ci              Exit 1 when a "Fix this first" finding is found [CI]
      --json            Print the result as JSON on stdout, and nothing else
      --only <value>    source: run just these checks, by id, separated by
                        commas (an unknown id is refused)
      --quiet           Print only results and errors
      --verbose         Show each request, and technical detail when something
                        goes wrong
  -h, --help            Show this help and exit
  -v, --version         Print the version and exit

Exit codes: 0 ran, 1 --ci and a fix-first finding, 2 could not run
```

`gaugeline source` reads a project's folder and runs the checks that look at code, not at a page: three that find a site meant to stay out of search being put back in by its own settings, and others for the Sanity publish webhook and cache and for tokens in code. It sends no request, runs
no code and never opens `.env` or other secret-looking files. A check that cannot tell says so instead of
passing. An example from a pop-up bar's pre-launch copy: [Checks that read your source](guides/source-checks.md).

### The receipts command

`gaugeline receipts --help` prints:

```text title=Output
Usage: gaugeline receipts verify <file|folder> [options]

Check an exported chain of approval receipts with no network and no key: every
receipt's hash, each link to the one before, the genesis value, the order, and
no gaps, forks or repeated drafts. A folder holds receipts.jsonl and, if you
kept them, the approved payloads as payloads/<draft id>.txt, each checked
against its receipt and never printed. Stops at the first broken receipt and
says which and why. Tamper evidence, not a signature: whoever controls the
database can rebuild the whole chain; --head with a head hash you wrote down
elsewhere finds that, and a cut-off end. (gaugeline receipt, singular, is the
care-plan receipt: a different command.)

Options:
      --json            Print the result as JSON on stdout, and nothing else
      --head <value>    receipts verify: a head hash written down earlier, which
                        the chain must still contain
      --quiet           Print only results and errors
      --verbose         Show each request, and technical detail when something
                        goes wrong
  -h, --help            Show this help and exit
  -v, --version         Print the version and exit

Exit codes: 0 the chain checks out, 1 a problem found, 2 could not read
```

`gaugeline receipts verify` checks a chain of approval receipts exported from the hosted inbox, on your own
computer, with no network and no key. It is not the care-plan receipt (`gaugeline receipt`, above). Exit 0
when the chain checks out, 1 at the first broken receipt (which one and why), 2 when the file cannot be read.
It is tamper evidence, not a signature: see [Verify approval receipts](guides/verify-receipts.md) for what it
does and does not prove.

### The evals command

`gaugeline evals --help` prints:

```text title=Output
Usage: gaugeline evals [--agent <id>] [--out <file>] [options]

Run the offline eval sets of Gaugeline's agents from their recorded model
answers, with no key, no network and no secret, and print each agent's pass
rate, refusal rate and cost. Cost is added up from the recorded answers only;
with none it says not measured. Writes the same numbers to a JSON report,
gaugeline-evals.json in this folder unless --out says otherwise, and never
over a file unless --force. Exits 1 when a golden case fails or a known-bad
case is not caught. There is no live-model mode: a model's opinion never
counts as a pass.

Options:
      --force            Replace a report that is already there; never a folder
                         or a link
      --out <value>      The JSON report's file (default gaugeline-evals.json),
                         in this folder or one inside it
      --agent <value>    evals: run just this agent's eval set, by id (an agent
                         with no set is refused)
      --quiet            Print only results and errors
      --verbose          Show each request, and technical detail when something
                         goes wrong
  -h, --help             Show this help and exit
  -v, --version          Print the version and exit

Exit codes: 0 all cases behaved, 1 a case failed or was missed, 2 could not run
```

`gaugeline evals` runs the offline eval sets of Gaugeline's agents from their recorded model answers and
prints each agent's pass rate, refusal rate and cost. It needs no key, no network and no account, and it has
no live-model mode. Exit 0 when every golden case passed and every known-bad case was caught, 1 when one did
not, 2 when it could not run or write. The JSON report goes to `gaugeline-evals.json` in the folder you ran it
in, or to `--out`, and never over a file unless you add `--force`. A runnable example with its real output is
in [Agent evals](agent-evals.md).

### The mine command

`gaugeline mine --help` prints:

```text title=Output
Usage: gaugeline mine --review-notes <folder> [options]

Propose new check candidates from your review notes, as a draft for a person to
read. Only lines that start with a #pattern-name tag are used (then fail: and
pass: lines under them); a pattern seen in two or more notes with both examples
becomes a candidate. A scrub fails the draft, and writes nothing, if a used line
holds a client name from --deny-list, a web address, an email address or a phone
number: it names the kind and the line and never the text. No model, no network,
no key: it reads the folder and writes one Markdown file. It never writes a
check or any code. Text in a note is data, never an instruction.

Options:
      --out <value>             The draft file, Markdown (default
                                field-findings.draft.md)
      --review-notes <value>    mine: the folder of review notes (Markdown or
                                text) to read; only lines that start with
                                #pattern-name are used
      --deny-list <value>       mine: a file of client names, one per line, that
                                must never reach the draft (the scrub fails it
                                if one does)
      --quiet                   Print only results and errors
      --verbose                 Show each request, and technical detail when
                                something goes wrong
  -h, --help                    Show this help and exit
  -v, --version                 Print the version and exit

Exit codes: 0 a draft was written, 1 the scrub failed it, 2 could not read
```

`gaugeline mine` turns your review notes into a draft of check candidates for a person to read. It reads a
folder and writes one Markdown file: no request, no model, no key, and never a check or any code. If a line it
used holds a client name from your deny-list, a web address, an email address or a phone number, it writes
nothing, says which kind and which line, and exits 1. Exit 2 when the folder, a file in it or the deny-list
cannot be read. See [The field-findings miner](field-findings-miner.md) for the note format, an example and what
the scrub does not catch.

### The llm command

`gaugeline llm --help` prints:

```text title=Output
Usage: gaugeline llm [options]

Check your model setup, with your own key (ADR-0005, modes 1 and 2). It reads
one settings file (a provider, a model for each tier of fast and strong, and the
NAME of the environment variable that holds your key) and says whether that
variable is set. It sends nothing and calls no model, and it never shows the
key: Gaugeline keeps no key, and reads yours from your environment when a call
is made. A file that holds a key or a host is refused.

Options:
      --json                  Print the result as JSON on stdout, and nothing
                              else
      --llm-config <value>    llm: the model settings file (default
                              gaugeline.llm.json); it names your key's variable,
                              never the key
      --quiet                 Print only results and errors
      --verbose               Show each request, and technical detail when
                              something goes wrong
  -h, --help                  Show this help and exit
  -v, --version               Print the version and exit

Exit codes: 0 ran (also when the key is not set), 2 could not run
```

`gaugeline llm` checks the model setup you would use for an agent that words a draft, with your own key. It
reads the one settings file named with `--llm-config` (default `gaugeline.llm.json`) and the one environment
variable that file names, and says whether that variable holds a usable key. It makes no request, calls no model
and never shows the key. A file that holds a key, a host or any setting it does not know is refused. The file's
shape, the two modes and what Gaugeline keeps: [The model gateway](model-gateway.md#your-own-key).

### The house-rules command

`gaugeline house-rules --help` prints:

```text title=Output
Usage: gaugeline house-rules --rules <file> [options]

Turn a site's written rules (a plain-text or Markdown style guide: headings in
sentence case, no em dashes, buttons say Book now, never use the word cheap,
phone numbers formatted like 000 000 0000) into a DRAFT house-rules file for
you to review. It reads that one file and nothing else: no request, no model,
no key. A line it has no pattern for is listed as not understood and never
guessed; a line that names a pattern or a file path is refused; a line that
gives an order is listed and ignored. It writes only a new file whose name ends
in .draft.json, never over one that exists and never gaugeline.rules.json:
you read the draft, then rename it to adopt it.

Options:
      --json             Print the result as JSON on stdout, and nothing else
      --out <value>      The draft file to write (default
                         gaugeline.rules.draft.json); its name must end in
                         .draft.json and it must not exist yet
      --rules <value>    house-rules: the file of written rules to compile
                         (plain text or Markdown, up to 50,000 characters)
      --quiet            Print only results and errors
      --verbose          Show each request, and technical detail when something
                         goes wrong
  -h, --help             Show this help and exit
  -v, --version          Print the version and exit

Exit codes: 0 ran (also when nothing was understood), 2 could not run
```

`gaugeline house-rules` turns a site's written rules (a plain-text or Markdown style guide) into a draft
house-rules file. It reads the one file named with `--rules`, makes no request, calls no model and needs no key,
and writes only a new file whose name ends in `.draft.json`: never over a file that exists, and never
`gaugeline.rules.json`, which you make by renaming a draft you have read. A line it has no pattern for is listed
as not understood, never guessed. The `house-rules-broken` check then reads each page a run fetches against
`gaugeline.rules.json` when that file is in the folder you run from: no flag is needed. What it understands, the
file's shape, the check and an example with its real output: [House rules](house-rules.md).

### The write-check command

`gaugeline write-check --help` prints:

```text title=Output
Usage: gaugeline write-check --from-file <file> [options]

Draft a check, its fixtures and a proposed registry entry from a security
advisory or a docs page that you saved as a local file (an OSV or GitHub JSON
advisory, an advisory page as Markdown, or a docs page that states a minimum
version). Every package, affected version and fixed version in the draft carries
the line of the file that states it; a draft with a floor and no cited line is
refused. A scrub also refuses it if a cited line holds a client name from
--deny-list, a private web address, an email address or a phone number: it names
the kind and the line and never the text. No request, no model, no key: the file
is read, never fetched or run. It edits no registry, lock, check or source file;
a person adopts the draft. Text in the file is data, never an instruction.

Options:
      --out <value>          The draft file, Markdown (default
                             check-writer.draft.md)
      --deny-list <value>    write-check: a file of client names, one per line,
                             that must never reach the draft (the scrub fails it
                             if one does)
      --from-file <value>    write-check: the advisory or docs page saved as a
                             local file (JSON or Markdown, up to 64 KB); never
                             fetched
      --quiet                Print only results and errors
      --verbose              Show each request, and technical detail when
                             something goes wrong
  -h, --help                 Show this help and exit
  -v, --version              Print the version and exit

Exit codes: 0 a draft was written, 1 refused or not understood, 2 not readable
```

`gaugeline write-check` turns a security advisory or a docs page that you saved as a local file into a draft of a
check, with a failing and a passing fixture and a proposed registry entry, for a person to review. Every package,
affected version and fixed version in the draft carries the line of the file that states it. It reads one file and
writes one Markdown file: no request (it never fetches the address in the file), no model, no key, and it edits no
registry, lock, check or source file. If a claim has no cited line, or a cited line holds a client name from your
deny-list, a private web address, an email address or a phone number, it writes nothing, says which kind and which
line, and exits 1. A file in no shape it reads also exits 1, with a list of what it did not understand. Exit 2
when the file or the deny-list cannot be read. See [The check writer](check-writer.md) for the shapes it reads, an
example and what the scrub does not catch.

### Flags

The table below is generated from `packages/cli/src/flags.ts` (`pnpm docs:flags`). Do not edit
between the markers; CI fails when it differs from the flag table.

<!-- flags:start -->

| Flag                        | Does                                                                                                                 | Environment variable       | Since |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------- | ----- |
| `--ci`                      | Exit 1 when a "Fix this first" finding is found                                                                      | `CI`                       | 0.1.0 |
| `--json`                    | Print the result as JSON on stdout, and nothing else                                                                 |                            | 0.1.0 |
| `--format <value>`          | What stdout carries: json (as --json), sarif, junit or one-pager (a cited page; view reads a saved run)              |                            | 0.2.0 |
| `--json-schema <value>`     | With --json: the result schema to print, 2 (the default) or 3 (also lists what suppressions and the baseline hide)   |                            | 0.2.0 |
| `--no-open`                 | Do not open anything in a browser                                                                                    |                            | 0.1.0 |
| `--demo`                    | Start the app with example results about invented sites; no address is checked and nothing is requested              |                            | 0.2.0 |
| `--ads <value>`             | Start the app with an ads export read from this file (a Meta Ads Manager or Google Ads CSV)                          |                            | 0.2.0 |
| `--allow-private`           | Allow addresses on this computer or a private network, such as 127.0.0.1 or 192.168.x.x                              |                            | 0.1.0 |
| `--allow-secret-key`        | Use a Stripe secret key, with a notice, instead of refusing it; a restricted key is safer                            |                            | 0.2.0 |
| `--dns`                     | Also read the domain's mail records (SPF and DMARC) from DNS                                                         |                            | 0.2.0 |
| `--renewals`                | Also check what lapses: the domain's registration, the certificates and any token you set up                         |                            | 0.2.0 |
| `--cost`                    | Also check what runs up the hosting bill: pages that change on every visit, the cache and usage jumps                |                            | 0.2.0 |
| `--trackers`                | Also list the trackers on pages with a form or a path you listed, and what a tag manager holds                       |                            | 0.2.0 |
| `--renderer <value>`        | Also load the page in a browser you installed (playwright), to read what scripts add; never downloads one            |                            | 0.2.0 |
| `--pagespeed`               | Also read Google's PageSpeed Insights: real-user vitals decide, lab is advice; sends page addresses to Google        |                            | 0.2.0 |
| `--attribution`             | With --renderer: reload the page without motion, scripts or third parties and say which moves load time              |                            | 0.2.0 |
| `--libraries`               | Also check the JavaScript files a page loads for libraries with a published advisory                                 |                            | 0.2.0 |
| `--wordpress`               | Also check a WordPress site's versions against the current releases, and whether it lists its users                  |                            | 0.2.0 |
| `--backups`                 | Also check when the client's content and database were last backed up (Supabase, Sanity, an export folder)           |                            | 0.2.0 |
| `--published`               | Also check that content changed in your CMS is live on the site, and that unpublished pages are gone                 |                            | 0.2.0 |
| `--owner-consent`           | Run the probing checks, which ask routes for what they protect with no login; only on sites you may test             |                            | 0.2.0 |
| `--routes <value>`          | With --owner-consent: download routes in files matching this glob (repeatable); no glob: a folder's signed-in routes |                            | 0.2.0 |
| `--since <value>`           | Page check: compare with the last run (the only value is last). delivery: the window to read, such as 7d             |                            | 0.2.0 |
| `--before-after`            | Print two saved runs side by side: fixed, new and still there (--since names the before run)                         |                            | 0.2.0 |
| `--coming-up`               | Also read what lapses in the next 60 days (domain, certificates, tokens) for Coming up                               |                            | 0.2.0 |
| `--month <value>`           | The month a receipt covers, as yyyy-mm in UTC (default: the last whole month)                                        |                            | 0.2.0 |
| `--client-reported <value>` | A fix your client reported first, as a check id with an optional page (payment-link-dead@/visit); repeatable         |                            | 0.2.0 |
| `--printable`               | Print the receipt as one page to print or save as a PDF, instead of Markdown                                         |                            | 0.2.0 |
| `--paid`                    | Count the orders paid in Stripe in the window; with --sent, compare them with the emails                             |                            | 0.2.0 |
| `--sent`                    | Count the emails Resend says it sent in the window; with --paid, compare them with the orders                        |                            | 0.2.0 |
| `--dupes`                   | With query: name documents that share a slug or a title (reads each one's id, slug and title)                        |                            | 0.2.0 |
| `--mutations`               | With query: check the writes in your code against the schema (parsed, never sent)                                    |                            | 0.2.0 |
| `--graphql`                 | With query: check the GraphQL in your code against the schema (an endpoint may follow; Sanity's when none)           |                            | 0.2.0 |
| `--suggest`                 | With query: write a GROQ query for a type from the schema and document counts (needs --type)                         |                            | 0.2.0 |
| `--page`                    | With query: write a route (queries, types, page) from the schema and counts into --out (needs --type)                |                            | 0.2.0 |
| `--unused`                  | With query: list fields your queries fetch that no code reads, GROQ and GraphQL (source only, no request)            |                            | 0.2.0 |
| `--totals <value>`          | With query: check a stated number against the sum of its parts, as type:stated=parts (repeatable)                    |                            | 0.2.0 |
| `--refs <value>`            | With query: find documents that link to things nobody published, as type:path (repeatable)                           |                            | 0.2.0 |
| `--save <value>`            | With query: save today's gaps (names only) to this file, to compare a later run with                                 |                            | 0.2.0 |
| `--against <value>`         | With query: list the gaps created since the --save file, and those it closed; --ci fails on a new high one           |                            | 0.2.0 |
| `--type <value>`            | With query --suggest or --page: the document type to write the query or the route for, as in your schema             |                            | 0.2.0 |
| `--schema <value>`          | With query: the schema file (sanity schema extract; SDL or introspection JSON for --graphql)                         |                            | 0.2.0 |
| `--webhooks`                | Read Stripe's webhook endpoints and the events that were never delivered                                             |                            | 0.2.0 |
| `-i`, `--interactive`       | Open a terminal view of the results to move through, filter and dismiss findings                                     |                            | 0.2.0 |
| `--slack <value>`           | Send a summary to this Slack incoming webhook (or set GAUGELINE_SLACK_WEBHOOK)                                       |                            | 0.2.0 |
| `--discord <value>`         | Send an embed to this Discord webhook (or set GAUGELINE_DISCORD_WEBHOOK)                                             |                            | 0.2.0 |
| `--webhook <value>`         | POST the result as JSON to this address (or set GAUGELINE_WEBHOOK)                                                   |                            | 0.2.0 |
| `--email <value>`           | Email the full report to these addresses through Resend (or set GAUGELINE_EMAIL)                                     |                            | 0.2.0 |
| `--plan-only`               | Check the plan on its own, before anything is built (no requests)                                                    |                            | 0.2.0 |
| `--sheet <value>`           | Read this tab of a workbook instead of the one with a URL column                                                     |                            | 0.2.0 |
| `--legacy-from <value>`     | Read old addresses from this notes column when the plan has no Legacy URL column (repeatable)                        |                            | 0.2.0 |
| `--legacy-review <value>`   | Write the old addresses read with --legacy-from to this CSV file, for review                                         |                            | 0.2.0 |
| `--base <value>`            | The site a plan is checked against (a preview); the site emails link to; or the site to ask for --routes             |                            | 0.2.0 |
| `--annotate <value>`        | Write a copy of the plan with a Gaugeline column saying what is wrong on each row                                    |                            | 0.2.0 |
| `--force`                   | Let --annotate (plan), --page, --save (query), --out (brief), handoff or audit replace files, never a folder or link |                            | 0.2.0 |
| `--progress <value>`        | With --base, say what was fixed and what is new since the last run (state file optional)                             |                            | 0.2.0 |
| `--watch <value>`           | With --base on production: the 30-day watch from this cutover date (YYYY-MM-DD)                                      |                            | 0.2.0 |
| `--all`                     | plan --progress: list the findings still open; run: check every site in gaugeline.sites.json                         |                            | 0.2.0 |
| `--live <value>`            | List pages in this crawl, sitemap, Search Console export or list that the plan misses                                |                            | 0.2.0 |
| `--nav <value>`             | Check the menu tabs (all headed Main category, or these, comma separated) against the pages                          |                            | 0.2.0 |
| `--rank <value>`            | With --live, sort the missing pages by clicks from this Search Console or rank export                                |                            | 0.2.0 |
| `--ignore <value>`          | With --live, leave out paths matching this glob, such as /tag/* (repeatable)                                         |                            | 0.2.0 |
| `--printed <value>`         | With --base, add the printed register's addresses to the 301 map                                                     |                            | 0.2.0 |
| `--decode <value>`          | Read the QR code in these PNG images (or a folder) and add new ones to the register                                  |                            | 0.2.0 |
| `--tags <value>`            | Query parameters that must reach the destination, as name prefixes (default utm_)                                    |                            | 0.2.0 |
| `--site <value>`            | Check this site from gaugeline.sites.json, by name (repeatable)                                                      |                            | 0.2.0 |
| `--tag <value>`             | Check the sites in gaugeline.sites.json with this tag, such as client                                                |                            | 0.2.0 |
| `--parallel <value>`        | Check this many sites at once (default 1); sites on one host never overlap                                           |                            | 0.2.0 |
| `--limit <value>`           | Re-check this many of the export's pages (default 40; 0 only classifies the rows)                                    |                            | 0.2.0 |
| `--out <value>`             | snapshot: the file (default before.json). query --page: the folder. brief: the file. handoff, audit: the folder      |                            | 0.2.0 |
| `--business <value>`        | brief: the business the work order is for, shown in its heading. audit: the prospect's business                      |                            | 0.2.0 |
| `--rate <value>`            | brief: what an hour costs, in whole currency units such as 110; used with --hours-per-point                          |                            | 0.2.0 |
| `--hours-per-point <value>` | brief: how many hours one point takes, such as 1.5; prints a range of hours, never one number                        |                            | 0.2.0 |
| `--pack`                    | audit: turn the run into a proposal-ready pack (HTML and Markdown), using the packages in gaugeline.services.json    |                            | 0.2.0 |
| `--brand <value>`           | audit: your name, shown at the head and foot of the pack                                                             |                            | 0.2.0 |
| `--brand-logo <value>`      | audit: an https address for your logo; it is never fetched by Gaugeline, only by whoever opens the pack              |                            | 0.2.0 |
| `--brand-contact <value>`   | audit: your contact line, shown under your name                                                                      |                            | 0.2.0 |
| `--before <value>`          | The snapshot taken before cutover, written by gaugeline snapshot                                                     |                            | 0.2.0 |
| `--old <value>`             | migration: the old site's address, to read its list of pages and the pages themselves                                |                            | 0.2.0 |
| `--old-file <value>`        | migration: a Wix, Webflow or other export (CSV or JSON) that lists the old site's pages, read from this file         |                            | 0.2.0 |
| `--package <value>`         | advisory: a package@range to use instead of looking the id up in OSV (repeatable)                                    |                            | 0.2.0 |
| `--host <value>`            | advisory: another hostname of the client to look at, such as an old subdomain (up to 5)                              |                            | 0.2.0 |
| `--block`                   | deploy-gate: exit 1 when a "Fix this first" finding is found; without it the gate only reports                       | `GAUGELINE_GATE_BLOCK`     | 0.2.0 |
| `--only <value>`            | source: run just these checks, by id, separated by commas (an unknown id is refused)                                 |                            | 0.2.0 |
| `--agent <value>`           | evals: run just this agent's eval set, by id (an agent with no set is refused)                                       |                            | 0.2.0 |
| `--llm-config <value>`      | llm: the model settings file (default gaugeline.llm.json); it names your key's variable, never the key               |                            | 0.2.0 |
| `--rules <value>`           | house-rules: the file of written rules to compile (plain text or Markdown, up to 50,000 characters)                  |                            | 0.2.0 |
| `--head <value>`            | receipts verify: a head hash written down earlier, which the chain must still contain                                |                            | 0.2.0 |
| `--review-notes <value>`    | mine: the folder of review notes (Markdown or text) to read; only lines that start with #pattern-name are used       |                            | 0.2.0 |
| `--deny-list <value>`       | mine, write-check: client names, one per line, to keep out of the draft (the scrub fails it if one gets in)          |                            | 0.2.0 |
| `--from-file <value>`       | write-check: the advisory or docs page saved as a local file (JSON or Markdown, up to 64 KB); never fetched          |                            | 0.2.0 |
| `--fixes`                   | propose: turn fix proposals on (they are off by default); nothing is sent, the diffs are written to a file           | `GAUGELINE_FIXES`          | 0.2.0 |
| `--repo <value>`            | propose: the project's folder on this computer (a checkout of its repository)                                        |                            | 0.2.0 |
| `--plan <value>`            | propose: the launch plan (CSV); with --base, each old address that does not redirect gets a proposal                 |                            | 0.2.0 |
| `--to-inbox <value>`        | propose: also write each proposal as the hosted inbox's pull-request draft (JSON) to this file                       |                            | 0.2.0 |
| `--repository <value>`      | propose: the repository's name on GitHub (owner/name), written into each proposal; optional                          |                            | 0.2.0 |
| `--dry-run`                 | init: print the settings files it would write, and write nothing                                                     |                            | 0.2.0 |
| `--note`                    | advisory: print the short note for the client (Markdown) instead of the report                                       |                            | 0.2.0 |
| `--runs <value>`            | The folder of saved runs (each one saved with --json) to read                                                        |                            | 0.2.0 |
| `--time-zone <value>`       | The time zone for dates and ages, such as America/Los_Angeles (default UTC)                                          |                            | 0.2.0 |
| `--notify-on <value>`       | When to send: any (something was found, the default), high or always                                                 |                            | 0.2.0 |
| `--report-url <value>`      | Link each message to a hosted copy of the report at this address                                                     |                            | 0.2.0 |
| `--upload`                  | Upload the result to your hosted workspace; needs GAUGELINE_TOKEN and GAUGELINE_UPLOAD_URL (see the API page)        |                            | 0.2.0 |
| `--save-requests <value>`   | Save the requests made and the page's data to this JSON file; it may contain page content, so do not commit it       |                            | 0.2.0 |
| `--baseline <value>`        | Read or write a file of known findings; with it a run reports only new ones                                          |                            | 0.2.0 |
| `--update-baseline`         | With --baseline, write the file again from this run                                                                  |                            | 0.2.0 |
| `--config-json-only`        | Refuse a gaugeline.config.mjs, .js or .ts, which runs code; read gaugeline.config.json only                          | `GAUGELINE_NO_EXEC_CONFIG` | 0.2.0 |
| `--suppress <value>`        | Snooze a check id for this run, with an expiry and a reason (repeatable)                                             |                            | 0.2.0 |
| `--suppress-until <value>`  | With --suppress, the last day it applies, YYYY-MM-DD; a past date is refused                                         |                            | 0.2.0 |
| `--suppress-reason <value>` | With --suppress, why the finding is accepted for now                                                                 |                            | 0.2.0 |
| `--list`                    | Print the data assertions in gaugeline.sources.json and run none of them                                             |                            | 0.2.0 |
| `--quiet`                   | Print only results and errors                                                                                        |                            | 0.1.0 |
| `--verbose`                 | Show each request, and technical detail when something goes wrong                                                    |                            | 0.1.0 |
| `-h`, `--help`              | Show this help and exit                                                                                              |                            | 0.1.0 |
| `-v`, `--version`           | Print the version and exit                                                                                           |                            | 0.1.0 |

<!-- flags:end -->

Only "Fix this first" findings fail CI. "Fix soon" and "Worth knowing" never change the exit code.

### Config, baselines and suppressions

`gaugeline.config.json` (or `.mjs`, `.js`, `.ts`: those run code, see [Config](/docs/config#json-is-the-safe-default))
in the folder you run from sets which checks block, adds checks you wrote and snoozes findings with a date.
Four flags work with it on the page check and `launch`:

- `--baseline <file>`: if the file does not exist (under `--ci` that is exit 2), write the findings of this run to it (fingerprints, check ids
  and paths, never page text) and exit as if they were accepted; if it does, leave out the findings it holds
  and report only new ones, with a stderr line saying how many were already known. A file that is not a
  baseline, or was written by a newer version, is exit 2.
- `--update-baseline`: with `--baseline`, write the file again from this run.
- `--config-json-only` (or `GAUGELINE_NO_EXEC_CONFIG=1`): refuse a `gaugeline.config.mjs`, `.js` or `.ts`, which run code, as exit 2.
- `--suppress <id>`, with `--suppress-until YYYY-MM-DD` and `--suppress-reason "..."`: snooze a check for this
  run. All three are required, `--suppress` can be repeated, and a past date is exit 2. For a standing
  suppression, use the config file's `suppress` list: an entry past its `until` date stops applying and is
  reported.

Baselined and suppressed findings never fail `--ci`. See [Config, baselines and suppressions](/docs/config).

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
  `result.v2.json`, `result.v3.json`) are never edited in place; a new shape ships as a new file and
  the old files stay in the package so consumers can pin.

`--json-schema 3` (with `--json` or `--format json`) prints schema 3 instead: the same result with
`"schema": 3` and four more lists, `suppressed`, `expiredSuppressions`, `unmatchedSuppressions` and
`baselined`, which say what suppressions and `--baseline` left out of `findings`. Schema 2 is the default
and never gains a field; `--json-schema 2` is the same as leaving the flag out, and any other number is
exit 2. The shape is published as `result.v3.json`. A runnable example is in
[Config, baselines and suppressions](/docs/config#seeing-what-was-hidden-in-json). `--upload` and the
saved-run commands keep reading and sending schema 2.

### The upload option

`--upload` (page check and `launch`) sends the run's result to your hosted workspace after the run: the
same JSON `--json` prints, to `$GAUGELINE_UPLOAD_URL/runs`, with `GAUGELINE_TOKEN` as a Bearer token.
Both variables are required; there is no default address. One plain line on stderr says how it went,
and an upload failure never changes the exit code. If the value of a key in the environment is in the
result, nothing is sent. See [Hosted: the runs API](/docs/hosted/api).

### Saving the requests

`--save-requests <file>` writes the addresses a check requested and the page's data to a separate JSON
file. It is off by default, and `--json` is the same with or without it (schema 2). It works with the
page check (`gaugeline <address>`) and `gaugeline launch`; every other command refuses it with exit
code 2. The file may contain page content, so do not commit it. What is in it, how it is redacted and
cut to a size limit, when it can fail and how its own versioned schema will change are on
[Privacy and safety](privacy.md#saving-the-requests-save-requests).

### The delivery and platform commands

Two commands read accounts you own instead of a site. Neither takes an address, and both are read only:
the keys come from the environment and never reach a log, a finding or a report, and what is printed is
counts, hosts and days, never a name, an address, an order or a payload. `gaugeline delivery` and
`gaugeline platform --webhooks` send only `GET` requests. `gaugeline platform` with no flag asks
Supabase's own MCP server, in its read-only mode, for one project: those requests are `POST`s of a
read-only question to one registered address ([ADR-0006](https://github.com/alvinwquach/gaugeline/blob/main/docs/adr/0006-read-only-post-queries.md)),
never a write.

```sh
npx gaugeline delivery --paid --sent --since 7d
npx gaugeline platform --webhooks
npx gaugeline platform
```

- `gaugeline delivery --paid --sent [--since 7d]` counts the orders paid in Stripe (`STRIPE_API_KEY`)
  and the emails Resend says it sent (`RESEND_API_KEY`) in the window, and reports paid orders with no
  email (`delivery-receipt-missing`). Either flag alone prints that side's count. `--since` takes `7d`
  (the default), `24h` or a date such as `2026-11-01`, and anything else is exit 2. The page check's
  `--since last` is a different use of the same flag and is only for the page check.
- `gaugeline platform --webhooks` reads Stripe's webhook endpoints and the events that were never
  delivered, and reports an enabled endpoint with events older than an hour still waiting
  (`webhook-failing`) and a disabled endpoint (`webhook-disabled`).
- `gaugeline platform` with no flag reads the platforms named in `gaugeline.platforms.json` in the
  folder you run it from. Supabase is the one so far: `{ "supabase": { "projectRef": "<20-character id>" } }`,
  with the token in `SUPABASE_ACCESS_TOKEN` (a key in the file is refused). It reports a table in the
  `public` schema with row-level security off (`supabase-rls-off`) and the lints Supabase's security
  advisor raises (`supabase-security-advisor`). Without the file, and without `--webhooks`, it is exit 2
  and says so. The steps and what is kept are in [Supabase through its own MCP
  server](sources/supabase-mcp.md).
- All take `--json` (the schema 2 result and nothing else), `--ci` (exit 1 for a "Fix this first"
  finding) and `--allow-secret-key`. A missing or refused key is exit 2 and names the variable.

What they read, what keys to make, and how the match is made: [Paid downloads and
delivery](delivery.md#paid-and-the-receipt-never-went-out). What they send:
[Privacy and safety](privacy.md#orders-emails-and-webhooks-delivery-and-platform).

### The emails command

`gaugeline emails <folder>` checks the rendered emails in a folder (or one `.html` file) instead of a
site. It reads the files as text and never renders, runs or sends anything; each finding names the file
and the line. With no `--base` it makes no request. With `--base https://your-site.example` it asks that
site for the links and images the emails point at it, `GET` or `HEAD` only, 30 links and 20 images for
each email.

```sh
npx gaugeline emails ./emails
npx gaugeline emails ./emails --base https://example.com --ci
```

It takes `--base`, `--allow-private`, `--json` (the schema 2 result and nothing else, each finding's
`source` holding its file and line, `0` when the finding is about the whole email) and `--ci` (exit 1 for
a "Fix this first" finding). A missing folder, a folder with no `.html` and a settings file that does not
read are exit 2. Settings: `gaugeline.emails.json`, and the payments, facts and languages files the
page check reads. What runs on each email, how to get the folder from React Email or MJML, and two
examples: [Transactional emails](guides/emails.md).

### The renewals command

`gaugeline renewals <address>` lists what lapses on a client's site, soonest first, with the date written
out: the domain's registration (from the registry's public RDAP server, never WHOIS), the certificates of
the bare domain and www, and, only for tokens you put in `GAUGELINE_GITHUB_TOKEN` and
`GAUGELINE_VERCEL_TOKEN`, a token's expiry and a Vercel project's Node.js version. It does not need the
site to answer: a lapsed domain is read all the same.

```sh
npx gaugeline renewals marlowe-bar.com
npx gaugeline renewals marlowe-bar.com --ci
```

It takes `--ci` (exit 1 for a "Fix this first" finding), `--json` (the schema 2 result and nothing else),
`--allow-private`, `--no-open` and the notification flags, like the page check. `--renewals` adds the same
checks to the page check, and `gaugeline run --all --renewals` to every site of a nightly run. Settings:
`gaugeline.renewals.json` (the Vercel projects, and the domain when its ending is unusual). What it reads,
what keys to make and the thresholds: [Renewals](guides/renewals.md). What it sends:
[Privacy and safety](privacy.md#renewals-gaugeline-renewals).

### The handoff command

`gaugeline handoff <address>` writes a report of who owns each part of a client's site, and whether the
client can get in without you: the domain's registrar and name servers (from public records), and, with
the tokens you already have and only through `GET`, who holds the Vercel project, the Sanity project and
the Google Business Profile. It does not need the site to answer. Stripe, Square and other systems whose
users it cannot read become a checklist line, never a guess.

```sh
npx gaugeline handoff marlowe-bar.com
npx gaugeline handoff marlowe-bar.com --out client-handoff --dns
```

It writes `handoff.html`, `handoff.md` and `handoff.json` into `--out` (a folder inside the one you ran
from, `gaugeline-handoff` when you leave it out), never over a file unless `--force`, all three or none.
It takes `--json` (the summary and nothing else; with no `--out` nothing is written), `--ci` (exit 1 for a
"Fix this first" finding: the client is not an owner or admin somewhere), `--dns` (the name servers from
DNS as well as from the registry), `--allow-private`, `--quiet` and `--verbose`. A settings file that does
not read, a folder outside this one, a report that is already there without `--force` and a failed write
are exit 2, before anything is requested where they can be. Settings: `gaugeline.handoff.json` (the
client's and your addresses, the Vercel project, the Sanity project, extra checklist lines). What it
reads, what keys to make, the three checks and two examples: [Handoff](guides/handoff.md). What it
sends: [Privacy and safety](privacy.md#handoff-gaugeline-handoff).

### The cost command

`gaugeline cost <address>` finds what runs up a client's hosting bill. It visits the page twice, a few
seconds apart and with no cookies, and says whether the HTML changes on every visit, and, for the pages you
mark static in `gaugeline.cost.json`, whether the CDN ever serves them from its cache and whether their
cache lifetime is too short. With `GAUGELINE_VERCEL_TOKEN` set it also reads the account's usage and flags a
figure that jumped past a multiple of its recent average. A site on Wix, Squarespace, Webflow or Framer has a
fixed plan, so usage is "not applicable" there and the page checks still run. It prints the pages by likely
cause in plain sentences, then what to fix.

```sh
npx gaugeline cost marlowe-bar.com
npx gaugeline cost marlowe-bar.com --ci
```

It takes `--ci` (exit 1 for a "Fix this first" finding; these checks are never that), `--json` (the schema 2
result and nothing else), `--allow-private`, `--no-open` and the notification flags, like the page check.
`--cost` adds the same checks to the page check, and `gaugeline run --all --cost` to every site of a nightly
run. Settings: `gaugeline.cost.json` (the pages that should be cached, other pages to visit, the minimum
lifetime, the Vercel team, the usage window and multiple). What it reads, what key to make and the four
checks: [Hosting cost](guides/hosting-cost.md). What it sends:
[Privacy and safety](privacy.md#hosting-cost-gaugeline-cost).

### The backups command

`gaugeline backups <address>` finds out when a client's content and database were last backed up. Where a
platform documents a read-only way to ask, it reads Supabase's backups and point-in-time recovery (a project
named in `gaugeline.backups.json` and `SUPABASE_ACCESS_TOKEN`) and Sanity's dataset backups (`SANITY_TOKEN`
and `SANITY_PROJECT_ID`), and it lists the dated files of any export folder you name. It flags the newest
backup being older than `maxAgeDays` (7 by default), backups never switched on, and an export far smaller
than the one before. A platform whose backup status cannot be read becomes a line to check by hand, here and
on the handoff checklist. It prints each source, then what to fix.

```sh
npx gaugeline backups marlowe-bar.com
npx gaugeline backups marlowe-bar.com --ci
```

It takes `--ci`, `--json` (the schema 2 result and nothing else), `--allow-private`, `--no-open` and the
notification flags, like the page check. `--backups` adds the same checks to the page check, and
`gaugeline run --all --backups` to every site of a nightly run. It never starts a backup or an export, and an
export file is listed, never opened. What it reads, what keys to make and the three checks:
[Backups](guides/backups.md). What it sends: [Privacy and safety](privacy.md#backups-gaugeline-backups).

### The trackers option

`--trackers` adds two checks to the page check: the trackers (Meta, TikTok and LinkedIn pixels, Google
Analytics 4, Google Tag Manager, session replay tools) on a page with a form, an embedded form service or a
path you list, and what a Tag Manager container on such a page holds. It lists kind and id and nothing
else, and never says whether a tracker is allowed: that is for the client's own counsel. It is off by
default.

```sh
npx gaugeline clinic.example/intake --trackers
npx gaugeline clinic.example/intake --trackers --json
```

It checks the page you give it. `gaugeline run --all --trackers` adds it to every site of a nightly run.
Settings: `gaugeline.trackers.json` (`sensitivePaths`: exact paths or `/folder/*`). What it lists and what it
does not see: [Trackers on sensitive pages](guides/trackers-on-sensitive-pages.md). What it sends:
[Privacy and safety](privacy.md#trackers-on-sensitive-pages-trackers).

### The renderer option

`--renderer playwright` loads the page in a browser **you installed**, to read what a script adds. It is off
unless you name it, and it is read-only: only `GET` and `HEAD` leave the browser, private addresses are
refused, requests to a list of analytics and advertising services are stopped (a site's own analytics under another name may still be asked), nothing is clicked, typed or submitted, and
each page gets a fresh browser with no cookies or storage. Gaugeline never downloads a browser: with none
found (or no `playwright-core`), the run finishes, says how to install one, and any check that needs a
rendered page says could not check.

```sh
npx gaugeline bakery.example --renderer playwright
```

`playwright` is the only renderer. What it does, the caps, and how Gaugeline finds the browser
(`GAUGELINE_BROWSER_PATH`, then Playwright's own folder, then Chrome, Chromium or Edge):
[Rendered pages](rendered-pages.md). What it sends:
[Privacy and safety](privacy.md#rendered-pages-renderer-playwright).

### The pagespeed option

`--pagespeed` asks Google's PageSpeed Insights about the key pages (the page you typed and the first same-site
pages of the run's sample, at most five) and reports two things apart: what **real visitors** measured (Largest
Contentful Paint, Interaction to Next Paint and Cumulative Layout Shift at the 75th percentile), which decides
pass or fail, and a **lab score** from one simulated phone load, which is advice and never fails a page. It is
off unless you name it.

```sh
npx gaugeline pantry.example --pagespeed
```

It sends the address of each public page (no query string) to Google, with one `GET` and no key, and says so
on stderr first. A private or local address is never sent. Without a key the quota is shared and can be used
up; the check then says could not check, never a pass. Missing real-user data is could not check too.
What it reads and how it decides: [Speed](guides/pagespeed.md). What it sends:
[Privacy and safety](privacy.md#speed-from-google-pagespeed).

### The attribution option

`--attribution` (with `--renderer playwright`) loads the checked page in your browser five times, one after the
other: twice as it is, then with reduced motion forced, with JavaScript off and with scripts from other sites
blocked, and says which change moves the page's total blocking time or Largest Contentful Paint, and by how much.
Each change only takes something away, so it asks for nothing the plain load does not. Every finding is low
severity advice; the numbers are this computer's and unthrottled. Without `--renderer` it says it needs a
browser. Speed Index is not measured (it needs a video of the load).

```sh
npx gaugeline pantry.example --renderer playwright --attribution
```

What it reports and what it cannot say: [Speed attribution](guides/speed-attribution.md).

### The libraries option

`--libraries` adds one check to the page check: the version of jQuery, jQuery UI, Lodash, Moment.js, Bootstrap
or AngularJS in each script file the page loads (on the site or on another host), and the published
advisories that name that version, with the version that fixes each. It states facts and never says a site
is vulnerable. A file with no version in it, or a minified file with no library name, is could-not-check. It
is off by default.

```sh
npx gaugeline shop.example --libraries
npx gaugeline shop.example --libraries --json
```

It checks the page you give it. `gaugeline run --all --libraries` adds it to every site of a nightly run. There
is no settings file. At most 20 script files are read for one page, each once with `GET`, the first 2 MiB of
each, and only the scripts the page names. What it reads and what it does not see:
[Served libraries](guides/served-libraries.md). What it sends:
[Privacy and safety](privacy.md#served-libraries-libraries).

### The WordPress option

`--wordpress` adds two checks to the page check for a site built on WordPress: `wp-outdated` compares the
WordPress version the page shows, and the version of each plugin and theme in the `?ver=` on its files, with the
current releases from the public wordpress.org API; `wp-users-exposed` asks the site's REST API for its list of
users the way a visitor can, and asks for the id only. A site that hides its versions is could-not-check, never
up to date. It needs no key and is off by default.

```sh
npx gaugeline copper-lantern.example --wordpress
npx gaugeline copper-lantern.example --wordpress --json
```

It checks the page you give it. `gaugeline run --all --wordpress` adds it to every site of a nightly run. There
is no settings file: the WordPress adapter's own settings are in `gaugeline.adapters.json`. Each request is a
`GET`; at most 15 plugins and 15 themes are looked up in a run, each once. What it reads and what it does not see:
[WordPress](integrations/wordpress.md). What it sends:
[Privacy and safety](privacy.md#wordpress-wordpress).

### The published option

`--published` adds three checks to the page check for a site whose content lives in a CMS: `published-not-live`
compares the fingerprint of each field you chose (the title unless you say otherwise) of every item changed in
the last 7 days with the live page; `live-page-missing` finds a published item whose address answers 404;
`unpublished-still-live` finds a page that still serves after its item was unpublished or deleted. A page may
lag its item for a grace period (15 minutes). It uses the adapters in `gaugeline.adapters.json`, or the sitemap
and feed adapter when there is no file. It is off by default.

```sh
npx gaugeline lantern-ladle.example --published
```

It checks the site of the page you give it, once. `gaugeline run --all --published` adds it to every site of a
nightly run. Settings: the `live` entry of `gaugeline.adapters.json` (`days`, `graceMinutes`, `maxPages`,
`fields`). Each request is a `GET`, on the site being checked only, at most 40 pages in a run. What it reads and
what it does not see: [Published but not live](guides/published-not-live.md). What it sends:
[Privacy and safety](privacy.md#published-but-not-live-published).

### The query command

`gaugeline query <folder>` reads the GROQ in a repository instead of checking a site. It takes one folder and reads files. For every query it finds (`groq` tagged templates and `defineQuery()` calls in `.ts`, `.tsx`, `.js`, `.jsx` and `.mjs` files) it prints the document type, the fields the query reads, whether its filter leaves drafts out, its parameters, and the file and line it starts on. A query built at run time, a file that does not parse and a query with no `_type` filter are listed as unreadable, never skipped.

```sh
npx gaugeline query ./src
```

With `SANITY_PROJECT_ID` set (and `SANITY_DATASET`, `production` when unset, and `SANITY_TOKEN` with the Viewer role for a private dataset) it also asks the dataset for counts, one `GET` for each document type, and reports a field no document has (`query-field-absent`), a type with no documents (`query-type-empty`), a field some documents lack (`query-field-partial`) and a query whose filter leaves drafts out (`query-no-drafts-filter`). Counts only: no document is ever read. Without `SANITY_PROJECT_ID` it makes no request, needs no token and says so on stderr.

With `--dupes` (it needs `SANITY_PROJECT_ID`) it asks one more `GET` for each document type, for the `_id`, `slug.current` and `title` of each published document and nothing else, and reports documents of one type that share a slug (`query-dupe-slug`, "Fix this first") or a title (`query-dupe-title`, "Fix soon"), naming their ids. It is the one option whose output shows text your editors wrote, and it shows a slug or a title only when two documents share it. What it reads: [The same thing, twice](query-check.md#the-same-thing-twice).

With `--mutations` it also reads the writes in your code (patches, creates, transactions, the ones in webhook routes) and checks their shapes against a schema file: `--schema <file>`, or `./schema.json`, which `npx sanity schema extract` writes. It reports a field no type declares (`mutation-undeclared-field`), a create that leaves out a required field (`mutation-missing-required`), a reference written as a string (`mutation-ref-as-string`), a write with no drafts handling (`mutation-no-drafts`) and two routes that write one field (`mutation-shared-field`). The mutations are parsed and never sent: it needs no `SANITY_PROJECT_ID` and makes no request for them. A missing schema file is exit 2 and names `--schema`. What it reads: [Mutations, checked without running them](query-check.md#mutations-checked-without-running-them).

With `--graphql` it checks the GraphQL in your code instead of GROQ: `gaugeline query ./src --graphql [endpoint]`. It reads `.graphql` and `.gql` files and `gql` tags, asks the endpoint for its schema (Sanity's GraphQL API for your project when no address follows, built from `SANITY_PROJECT_ID` and `SANITY_DATASET`) with one `GET` and never a `POST`, and reports a field the schema does not have (`graphql-field-not-in-schema`, with the path and the file and line). For a Sanity endpoint it then counts the same document types in the dataset, as above. The first line of output is the endpoint. A token comes from `GRAPHQL_TOKEN`, or `SANITY_TOKEN` for Sanity's own address, and goes in a header. If the endpoint refuses the `GET` or has introspection turned off it exits 2 and offers `--schema <file>` (an SDL file or the JSON an introspection query returned), which asks no endpoint. An endpoint on this computer or a private network needs `--allow-private`. Mutations and subscriptions are counted and never sent. It cannot be combined with `--dupes` or `--mutations`. What it reads: [GraphQL, the same way](query-check.md#graphql-the-same-way).

It takes `--json` (the schema 2 result and nothing else; it needs `SANITY_PROJECT_ID` or `--mutations`) and `--ci` (exit 1 for a "Fix this first" finding). It exits 0 when it read the folder and 2 when the folder does not exist, TypeScript is not installed beside it (`npx -p gaugeline -p typescript gaugeline query ./src` brings it) or the dataset could not be read: a private dataset with no token names `SANITY_TOKEN` and the Viewer role. What it reads and what it lists as unreadable: [Checking your queries](query-check.md#what-the-command-reads); what it counts: [What it reports](query-check.md#what-it-reports).

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

There are twenty-seven probing checks: `ai-endpoint-open`, described in [AI routes that answer anyone](guides/ai-endpoints.md) (one `GET` of each route you list under `modelEndpoints` in `gaugeline.ai.json`, never a `POST`), `image-optimizer-open`, described in
[Open image optimizers](guides/image-optimizers.md#what-it-asks-the-running-site-a-probing-check) (it also needs an
address you chose, in `gaugeline.images.json`, below), `not-found-200`, described in [Error pages that answer 200](guides/error-pages.md#not-found-200-what-the-site-does-for-an-address-that-does-not-exist) (one `GET` of an address made up from your own site's address), `noindex-header-missing`, described in [Routes your page metadata does not reach](guides/noindex-header.md) (up to nine `GET`s: the made-up address and the routes you list in `gaugeline.hidden.json`), `studio-response-cacheable`, described in [Is the editor studio cached?](guides/studio-caching.md) (one `GET` of each studio route you name in `gaugeline.studio.json`, at most four), `gated-download-open`, described in
[Paid downloads and delivery](delivery.md#a-download-route-that-hands-the-file-to-anyone),
`route-hidden-not-protected`, described in [Routes that are hidden, not protected](protected-routes.md),
`nuxt-devtools-public` and `nuxt-preview-public`, described in
[Nuxt sites](guides/nuxt.md#probing-checks-run-only-on-sites-you-own-or-have-permission-to-test) (page checks, for
Nuxt sites only), `gatsby-graphql-public`, described in [Gatsby](guides/gatsby.md#the-checks),
`headless-wp-preview-open` and `headless-wp-introspection-open`, described in
[Headless WordPress](guides/headless-wordpress.md#the-checks), `qwik-solid-draft-public`, described in
[Qwik and SolidStart](guides/qwik-solidstart.md#the-checks), `remix-draft-public`, described in
[Remix and React Router](guides/remix.md#the-checks), `static-search-index-hidden`, described in
[Static site generators](guides/static-generators.md#the-checks), `sveltekit-draft-public`, described in
[SvelteKit](guides/sveltekit.md#the-checks) (these seven are page checks, for sites of that kind only), `strapi-drafts-public`, described in [Strapi](integrations/strapi.md#the-two-checks),
`umbraco-delivery-api-public`, described in [Umbraco](integrations/umbraco.md#the-two-checks),
`joomla-api-public`, described in [Joomla](integrations/joomla.md#the-two-checks),
`datocms-drafts-reachable`, described in [DatoCMS](integrations/datocms.md#the-check),
`directus-collection-public`, described in [Directus](integrations/directus.md#the-two-checks),
`drupal-unpublished-reachable`, described in [Drupal](integrations/drupal.md#the-check),
`hygraph-draft-live`, described in [Hygraph](integrations/hygraph.md#the-check),
`kontent-ai-unpublished-live`, described in [Kontent.ai](integrations/kontent-ai.md#the-check),
`payload-collection-public`, described in [Payload](integrations/payload.md#the-check),
`prismic-release-document-live`, described in [Prismic](integrations/prismic.md#the-checks), and
`sitecore-preview-public`, described in [Sitecore XM Cloud](integrations/sitecore.md#the-two-checks) (the last
eleven run from an adapter's reading, not from a page check).

`gaugeline.images.json` (in the folder you run from) holds the image optimizer settings. `settingsFiles` lists up
to six framework settings files (`next.config.js`, `nuxt.config.ts`, `astro.config.mjs`, `netlify.toml`) that are
read as text, never run, for an image allowlist that lets any host through (`image-optimizer-allowlist-wide` and
`image-optimizer-allowlist-unanchored`); that part needs no consent and sends nothing. `imageOptimizerProbeUrl` is
the one `https` address you chose, on a public host that is not one of your image hosts, for
`image-optimizer-open`; it is used only with `--owner-consent`, and Gaugeline never picks an address of its own.
There is no flag for it: the file is the one place that names the address.

```json title=gaugeline.images.json
{
  "imageOptimizerProbeUrl": "https://test-pictures.example/gaugeline-probe.png",
  "settingsFiles": ["next.config.js"]
}
```

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

`--routes` with no glob, and `--base`, are the second check's flags: `gaugeline check <folder> --routes --base <address>`
reads the Next.js routes in a folder (`app/` or `src/app/` inside it) and asks the running site at `--base` for
each one your code treats as signed-in only, with no session, then reports the ones that hand their page over.
The word `check` is optional, so `gaugeline ./src --routes --base https://example.com --owner-consent` is the same
command. Reading the folder makes no request; asking the site does, so it needs `--owner-consent` like the first
check, and without it the command exits 2 and asks nothing. `--base` is required (a missing one is exit 2 with a
usage message), and it may not carry a user name or a password: the command has no way to send a session, a cookie
or a token. A site on this computer or a private network needs `--allow-private`. At most 30 routes are asked, 5 at
a time; the rest are listed as not probed. `--json` and `--ci` work as for the page check (exit 1 for a handed-over
page). The route files are read as text and never run. What it finds and how it decides:
[Routes that are hidden, not protected](protected-routes.md). What it sends:
[Privacy and safety](privacy.md#signed-in-routes-a-probing-check).

```sh
npx gaugeline check ./src --routes --base https://fernbank-physio.example --owner-consent --ci
```

# The weekly digest

The owner of a bar doesn't read JSON. `gaugeline digest` reads a week of saved runs and writes what
changed, in sentences they can forward: a one-line verdict, what's new, what was fixed, what is
still open (oldest first, with how long), and what was checked. The plain part comes first; the
technical notes, with check ids and evidence, come after a divider.

## Saving runs

Save each run with `--json`, one file per run, in one folder:

```bash
npx gaugeline yoursite.com --json > runs/$(date -u +%F).json
```

Then, once a week:

```bash
npx gaugeline digest --runs runs --time-zone America/Los_Angeles
```

It writes `gaugeline-digest.md` and `gaugeline-digest.html` in the folder you run it from, and
prints the Markdown. Runs more than 7 days before the newest are left out (and counted), and the
folder must hold one site's runs. A file that isn't a saved run stops it (exit 2), naming the file.

## How it decides

- A finding is the same across runs when its check, its page and its evidence match, with numbers
  ignored: "3 of 12 images" on Monday and "4 of 13 images" on Friday are one finding.
- **New this week**: not in the first run of the week, still there in the last.
- **Fixed this week**: missing from the last run. It shows when it was first seen and the first
  run it was gone from, so something that opened and closed mid-week appears here with both dates.
- **Still open**: there in the first run and the last. Its age is counted in calendar days in
  `--time-zone` (UTC by default), so a week with a clock change still counts its days right.
- With only one run, nothing can be called new or fixed, and the digest says so.
- A week where nothing changed still says something: "Nothing changed. 104 things still agree."

The wording is each finding's plain sentence and the check's "what to do"; there are no check ids in
the plain part. Addresses never show their query string (a query can carry a token), and evidence
is passed through the same secret filter as every other output.

## Sending it

Nothing is sent unless sending is configured. `--email` (or `GAUGELINE_EMAIL`, with
`RESEND_API_KEY`) emails the HTML version through Resend, exactly as
[the email channel](../notifications.md) does; `--webhook` (or `GAUGELINE_WEBHOOK`) posts it as
JSON. A failed send is reported on stderr and never changes the exit code.

`examples/workflows/weekly.yml` in the repository runs the check every day, keeps each run as a
workflow artifact for 8 days, and on Mondays at 8:00 AM Pacific writes the digest, uploads it, and
sends it if those secrets are set.

## Example

Against the invented `digest-week` fixture (seven saved runs of a bookshop, Monday 2 to Sunday 8
November 2026), where a broken "Order online" link appeared on Wednesday and the missing share
picture was fixed the same day, `gaugeline digest --runs runs --time-zone America/Los_Angeles` prints:

```text title=Output
# harbour-books.example: the week

This week: 1 new thing to fix, 1 fixed and 2 older ones still open.

## New this week

- **Links on this page go nowhere** (on /, first seen Wed 4 Nov). What to do: Point each link at the page's current address, or remove it. When a page moved, add a 301 redirect from the old address.

## Fixed this week

- **Shared links have no picture** (on /, seen Mon 2 Nov, fixed by Wed 4 Nov).

## Still open

- **This page tells Google to show a different page** (on /, open 6 days). What to do: Give each page a canonical tag that points at its own address. Shared SEO components are the usual cause.
- **Some images have no alt attribute** (on /menu, open 6 days). What to do: Add alt to every img: a short description, or alt="" for decorative images.

## What was checked

https://harbour-books.example/ was checked 7 times between Mon 2 Nov and Sun 8 Nov. 104 things looked right in the latest check.

---

## Technical notes

- `broken-links on /: "Order online" <a href="https://harbour-books.example/order?…"> returned 404`
- `og-image-missing on /: no og:image on the page`
- `canonical-elsewhere on /: <link rel="canonical" href="https://harbour-books.example/old-home">`
- `images-alt-missing on /menu: 4 of 13 images on /menu have no alt attribute`
```

The link's `?session=` query string is cut to `?…`. The output is asserted by
`packages/cli/src/__tests__/digest.test.ts`, and the HTML version by a snapshot in
`packages/core/src/__tests__/digest.test.ts`.

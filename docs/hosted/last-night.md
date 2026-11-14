<!-- check-community: allow-email (invented people at reserved example domains) -->

# Hosted: what happened last night

The hosted version of Gaugeline (in progress, not released) has a page for the morning question: "what
changed overnight?" It sets each site's last run against the run before it and sorts the sites by what
happened. Open it from "Last night" in the header, after [signing in](/hosted/sign-in); the
[dashboard](/hosted/dashboard) is the list of sites, worst first.

## An example: the same four sites

Northgate Studio's morning, as Maya sees it (text of the page, from the stand-in server run against the
seeded test database):

```text
Last night
Northgate Studio
4 sites. 1 has new problems, 1 had problems closed, 1 is unchanged, 1 has not been checked yet.

New problems
  The Tidewater Bar
  https://tidewater-bar.test - last checked 12 Nov 2026, 03:00
  2 new, 1 still open, 0 closed.
  New
    Fix this first: Menu PDF is gone
      /menu links to <img src=x onerror=alert(1)> and returns 404
    Fix soon: No canonical address
      /book has no canonical link

Problems closed
  Juniper Pop-up Kitchen
  0 new, 1 still open, 1 closed.
  Closed
    Fix soon: Image has no alt text
      /gallery img 3

No change
  Harbour Yoga Studio
  0 new, 3 still open, 0 closed.

Not checked yet
  Linden Bakery
  No run has arrived for this site yet.
```

The bar has two problems that were not there the night before, and one that was and still is. Juniper's
kitchen fixed something. The yoga studio is exactly as it was. The bakery has never been checked.

## New, still open, closed

Findings are matched by **fingerprint**, the same 16-character hash the CLI uses for baselines, so a
finding is the same finding from one night to the next even if its wording changed.

| Word       | Means                                  |
| ---------- | -------------------------------------- |
| New        | in the last run, not in the run before |
| Still open | in both                                |
| Closed     | in the run before, not in the last     |

A site's last run is compared with the run before it, not with "yesterday": a site whose run was skipped
for a night is compared with the last run it did have, and the page shows when that run was.

## The groups

Sites are grouped in the order a person reads them: **New problems** (any new finding, even if something
else closed), **Problems closed**, **No change**, **First check** (one run, nothing to compare with),
**Not checked yet**. Inside a group the order is the dashboard's, worst first. The sentence at the top
counts each group.

At most five new and five closed findings are listed per site, worst first, and the page says "and 3
more" for the rest. The counts are always complete.

## Who sees what, and text from the checked site

The page is read as the signed-in person: the policies in [data model and tenancy](/hosted/data-model)
decide which sites and findings exist for them, a client viewer's page is their one site, and a team with
no sites is told how a site appears. A finding's title and evidence line are text the checked site chose;
they are cleaned and escaped as on the dashboard, so the `<img ...>` in the example above is shown as
characters and never becomes an image.

## How it reads the database

One query for the counts of the last two runs of every site (shared with the dashboard) and one query for
the findings of every site that has two runs, classified by fingerprint with `exists` against the other
run (the index on `(site_id, fingerprint)` and on `run_id` serve it). Nothing is stored for the page.

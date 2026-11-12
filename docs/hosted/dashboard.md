<!-- check-community: allow-email (invented people at reserved example domains) -->

# Hosted: the dashboard

The hosted version of Gaugeline (in progress, not released) opens on a list of your sites, worst first.
You see which site got worse overnight and what the new problem is, without opening anything. Signing in is
covered in [sign in and the shell](/hosted/sign-in), and [what happened last night](/hosted/last-night)
lists the new, still open and closed findings behind each row.

## An example: four sites, one morning

Northgate Studio looks after four small-business sites. Last night's runs, as Maya (the owner) sees them
at 9 in the morning, taken from the stand-in server run against the seeded test database:

| Site                   | Fix this first | Fix soon | Since the run before | Last checked       | New since then                                                          |
| ---------------------- | -------------- | -------- | -------------------- | ------------------ | ----------------------------------------------------------------------- |
| The Tidewater Bar      | 2              | 1        | Worse                | 12 Nov 2026, 03:00 | Fix this first: Menu PDF is gone (`/menu links to ... and returns 404`) |
| Harbour Yoga Studio    | 0              | 3        | Still                | 12 Nov 2026, 03:00 |                                                                         |
| Juniper Pop-up Kitchen | 0              | 1        | Better               | 12 Nov 2026, 03:00 |                                                                         |
| Linden Bakery          | -              | -        | Not checked yet      | -                  |                                                                         |

The bar is first: it has two Fix this first findings, up from one, and one of them is new, so the page
shows it. The yoga studio has the same three Fix soon findings as the night before, so it says Still and
shows nothing new. The bakery has never been checked, so it is last and says so.

## The order and the words

- **Worst first.** Most Fix this first findings, then most Fix soon, then the site's name. A site that has
  never been checked goes after all the others.
- **Worse, Better, Still** compares the last run with the one before it. Fix this first decides; if those
  counts are equal, Fix soon decides; Worth knowing never moves a site. Equal on both is Still.
- **First check** means the site has one run, so there is nothing to compare with yet. **Not checked yet**
  means no run has arrived.
- **New since then** is the worst Fix this first or Fix soon finding in the last run whose fingerprint was
  not in the run before. A finding that is still open is not news. It is shown only for a site that has two
  runs. Fingerprints are the same 16-character ones the CLI uses for baselines.
- **Times** are in the site's own timezone, so "03:00" is the site's 03:00. A timezone that is not a real
  one is shown in UTC and says so.

Each of the three words is written out, not just coloured, so it reads the same without colour.

## Who sees which sites

You see the sites of the organisation selected in the header and nothing of another team's: the database
decides this (the policies in [data model and tenancy](/hosted/data-model)), and the list is read as you,
not as the server. A client viewer's list is their one site; the query asks for that site by name as well,
so the page does not rely on the policy alone. A team with no sites is told what to do next: a site appears
after its first run is uploaded (`gaugeline --upload`), and its results show the next morning.

## Text from the checked site

A finding's title and evidence line are text the checked site chose. The dashboard shows them as text: the
same cleaning the CLI applies before anything leaves the engine (hidden tag characters and bidirectional
controls removed, control characters shown, capped at 120 and 300 characters), then escaped. For example,
an evidence line of `/menu links to <img src=x onerror=alert(1)> and returns 404` appears on the page as
exactly those characters; no image is created and no script exists on the page to run.

## How it reads the database

Two queries for the whole list, however many sites: the counts for each site's last two runs (the index on
`(site_id, started_at desc)` serves "latest of each site"), then the newest finding of every site that has
two runs to compare. Nothing is stored for the page; every number is computed from `runs` and `findings`
as you read them. The app writes nothing here: runs and findings arrive through the runs API.

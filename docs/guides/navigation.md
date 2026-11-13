# Navigation and footer: what changed, and what got orphaned

A menu restructure moves, removes and renames links all at once. Every page still loads afterwards,
so nothing reports the page that lost its only link. Gaugeline reads the menus on every run, and
with `--since last` compares them with the last run's.

## How menus are read

Links are read by region from the HTML the site sends (no JavaScript is run): the header (`header`,
`nav`), the footer (`footer`) and the body. In a menu, each link keeps its parent item, so the same
page under two parents is two links. A link is its region, its parent and its destination, never
its text alone: a renamed link is the same link with new text.

Landmarks are used unless `gaugeline.nav.json`, in the folder you run from, names selectors:

```json
{
  "regions": { "header": "#site-menu", "footer": ".site-footer", "mobile": "#drawer" },
  "requiredFooter": ["privacy", "terms", "contact"]
}
```

## The checks

| Check              | Level          | When                                                                                   |
| ------------------ | -------------- | -------------------------------------------------------------------------------------- |
| `nav-changed`      | Fix this first | A link was removed and no page read links to its page any more                         |
| `nav-changed`      | Fix soon       | A link was removed, or moved to another parent                                         |
| `nav-changed`      | Worth a look   | A link was added, renamed or reordered                                                 |
| `nav-orphans`      | Fix soon       | Sitemap pages that no page read links to                                               |
| `nav-parity`       | Fix soon       | The separate mobile menu lacks destinations the desktop menu has                       |
| `nav-footer`       | Fix soon       | A page's footer differs from the most common one, or a required footer link is missing |
| `nav-link-no-name` | Fix soon       | A header or footer link has no text, aria-label or labelled image                      |
| `nav-utm-lost`     | Worth a look   | A menu link's redirect drops the campaign tags it was asked with                       |
| `nav-link-not-200` | Fix this first | A menu link takes two or more redirects, loops, or ends on something that is not a 200 |

- `nav-changed` runs with `--since last`. On the first run there is nothing saved: it is "could not
  be checked", and that run saves the menu. Without `--since last` it has nothing to compare, like
  the other change checks.
- `nav-orphans` and `nav-footer` read the run's other pages (4 more requests), so they run with
  `--since last` or a `gaugeline.nav.json`. A page linked only from a page that wasn't read is
  reported too; the evidence says how many pages were read.
- `nav-parity` compares a separate mobile menu in the HTML (`[data-mobile-menu]`, `#mobile-menu`,
  `.mobile-menu`, or the config's selector) with the header. A menu toggle whose menu isn't in the
  HTML is built by JavaScript at a phone width: it is "could not be checked" until rendered reads
  are on. A submenu that opens on hover is in the HTML and is read.
- A reorder counts only when links present in both runs change places: a link removed above
  another doesn't move it.

## Menu links with no name

An icon-only link (a basket, a phone, an envelope, a social logo) reads to a screen reader as just "link", and
voice control has nothing to say to reach it. `nav-link-no-name` reads the header and footer links of the page
from the HTML the site sent and lists the ones whose accessible name is empty. It makes no request of its own.

The name is worked out in the order a browser uses: `aria-labelledby`, then `aria-label`, then what is inside
the link (text, an image's `alt`, an svg's `<title>`, a labelled descendant), then the `title` attribute.
Content marked `hidden` or `aria-hidden="true"` adds nothing, and whitespace, no-break spaces and zero-width
characters count as empty. Styles are not applied, so text a stylesheet hides still counts as a name. The
regions are the ones above: `header`, `nav` and `[role=banner]`, `footer` and `[role=contentinfo]`, or the
selectors in `gaugeline.nav.json`. A link in the page body is not read.

<!-- fixture: nav-names -->

```sh title=Terminal
$ npx gaugeline millracephysio.example
```

```text title=Output
! Some menu links have no name
    3 links have no accessible name: header link to /contact, header link to tel:+15550100, footer link to /book
· Images use older, heavier file formats
    1 of 1 sampled images are JPEG, PNG or GIF only: /og.png
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

2 to look at, none to fix first.
```

Millrace Physio is an invented physiotherapy clinic (`packages/fixtures/sites/nav-names`). Its envelope and phone
icons and its footer image link have no name; the icon with `aria-label="Book a visit"` is fine. The output is
asserted by `packages/cli/src/__tests__/nav-names.test.ts` and checked by `pnpm docs:examples`.

## Menu links and campaign tags

A visit that arrives with `utm_` tags is only counted for its campaign if the tags survive every redirect. A
menu link that redirects without passing the query string on is the quiet way to lose them. For a bar, a
pop-up or a clinic that has just moved its pages, the "What's on" and "Private hire" links are usually the
ones that redirect.

`nav-utm-lost` asks every header and footer destination of the checked page on your own site once, with three
test tags added (`utm_source=gaugeline-check`, `utm_medium=menu-test`, `utm_campaign=nav-links`: Gaugeline's own
values, never yours), and compares the tags on the first address with the last:

- It sends one HEAD per destination (a GET only when the server answers 405 or 501), through the same fetcher
  as every other check: nothing is submitted and nothing is clicked.
- At most 40 destinations are asked, header links first. A longer menu says how many were not asked, under
  could not check.
- A redirect that keeps the tags passes. One that drops any of them is a finding that names the link, the
  redirect's status, the hop and the tags it dropped.
- A link that ends in 404 or 500 is not judged here (`broken-links` reports it). A `401`, `403` or `429` is
  could not check.
- Only redirects are followed: a script that rewrites the address after the page loads is not seen.

<!-- fixture: nav-utm -->

```sh title=Terminal
$ npx gaugeline lanternbar.example
```

```text title=Output
! A menu link drops campaign tags
    1 of 6 menu links lose campaign tags: header › What's on: the 301 at hop 1 from /whats-on to /events drops utm_source, utm_medium, utm_campaign. Gaugeline's own test values were used (utm_source=gaugeline-check, utm_medium=menu-test, utm_campaign=nav-links).
· Links on this page go through a redirect
    /whats-on (301) ends at /events
· Links on this page go through a redirect
    /private-hire (301) ends at /hire?utm_source=gaugeline-check&utm_medium=menu-test&utm_campaign=nav-links
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

Checked 4 of 5 other pages.
3 to look at, none to fix first.
```

The Lantern Bar is an invented neighbourhood bar (`packages/fixtures/sites/nav-utm`). Its "What's on" link is a
301 to `/events` with no query string; "Private hire" redirects to `/hire` and carries the tags on. The output is
asserted by `packages/cli/src/__tests__/nav-utm.test.ts` and checked by `pnpm docs:examples`.

## Menu links that don't answer 200 at once

A menu link is the most-followed link on the site. `nav-link-not-200` reads the whole trail of every header and
footer destination of the checked page on your own site, and reports the ones that do not land on a page at
once:

- **A chain.** Two or more redirects, with the hop count and each hop's status and address, for example
  `takes 2 redirects (301 /services, 302 /our-services, 200 /care)`. The usual cause is one rule for the old address and
  another added later for the one it points at.
- **A loop**, or more than 10 hops, said as such.
- **A 2xx that is not a page** (a `204`, for one).
- **A dead menu link** (4xx or 5xx) that the link sample never reached: the sample is the first 30 same-site links,
  so a footer link past the 30th would otherwise go unseen.

What it leaves to other checks, on purpose: a single redirect is `links-via-redirect`'s; a 4xx or 5xx that the
link sample found is `broken-links`'s; a link into a hidden section or a draft is `hidden-linked`'s and
`drafts-live`'s. A `401`, `403` or `429` is could not check.

The answers are shared, not asked again: a link the link sample already asked reuses that answer, and the others
(at most 40 destinations in all, header first) are one HEAD each, or a GET when the server refuses HEAD.

<!-- fixture: nav-chain -->

```sh title=Terminal
$ npx gaugeline marlowvets.example
```

```text title=Output
✗ Links on this page go nowhere
    "Our rooms" <a href="/old-rooms"> returned 404
✗ Menu links don't answer 200 at once
    1 of 6 menu links does not answer 200 at once: header › Vaccinations redirects in a loop (302 /vaccinations, 302 /vaccinations-2)
! Menu links don't answer 200 at once
    2 of 6 menu links do not answer 200 at once: header › Services takes 2 redirects (301 /services, 302 /our-services, 200 /care), header › Newsletter answers 204, not 200
! A menu link drops campaign tags
    1 of 6 menu links lose campaign tags: header › Services: the 301 at hop 1 from /services to /our-services drops utm_source, utm_medium, utm_campaign. Gaugeline's own test values were used (utm_source=gaugeline-check, utm_medium=menu-test, utm_campaign=nav-links).
· Links on this page go through a redirect
    /services (301) ends at /care
? nav-utm-lost could not be checked: header › Vaccinations redirects in a loop, so its tags were not followed to a page (/vaccinations)
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

Checked 4 of 5 other pages.
5 to look at, 2 to fix first.
```

Marlow Vets is an invented veterinary practice (`packages/fixtures/sites/nav-chain`): its "Services" link takes two
redirects, "Vaccinations" loops, "Newsletter" answers 204 and "Our rooms" is a 404 that `broken-links` reports. The
output is asserted by `packages/cli/src/__tests__/nav-chain.test.ts` and checked by `pnpm docs:examples`.

## Example

The invented Rye and Ember bakery (`packages/fixtures/sites/nav-before` and `nav-after`).

### Before the restructure

Checked with `gaugeline ryeember.example --since last`, which saves the menu:

```text title=Output
· Shared links have no picture
    no og:image on http://ryeember.example/
? csp-loosened could not be checked: no saved scripts and headers to compare with yet: this run saves them (/)
? nav-changed could not be checked: no saved menu to compare with yet: this run saves one (/)
? page-gone could not be checked: no saved pages to compare with yet: this run saves them (/)
? page-lost-content could not be checked: no saved pages to compare with yet: this run saves them (/)
? page-lost-items could not be checked: no saved pages to compare with yet: this run saves them (/)
? page-lost-structured-data could not be checked: no saved pages to compare with yet: this run saves them (/)
? script-changed could not be checked: no saved scripts and headers to compare with yet: this run saves them (/)
? security-header-loosened could not be checked: no saved scripts and headers to compare with yet: this run saves them (/)
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

Checked 4 of 10 other pages.
1 to look at, none to fix first.
```

### After the restructure

Catering moves under Menu, About becomes Our story, Gift cards leaves the menu, the new mobile
menu has no Visit, and one template's footer has no Terms. The same command prints:

```text title=Output
✗ The menu changed since the last run
    Removed: header › Gift cards (/gift-cards); no page read links to /gift-cards now
! The menu changed since the last run
    Moved: header › Catering (/catering) from the top level to Menu
! The footer isn't the same on every page
    The footer on /menu/breads differs from 4 other pages: no link to /terms
! Pages in the sitemap that no page links to
    1 sitemap address has no link from the 5 pages read: /gift-cards
! The mobile menu is missing links the desktop menu has
    The mobile menu has no link to /visit, which the desktop menu has
· The menu changed since the last run
    Renamed: header › "About" to "Our story" (/about)
· Shared links have no picture
    no og:image on http://ryeember.example/
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

Checked 4 of 9 other pages.
7 to look at, 1 to fix first.
```

`/gift-cards` is the one page left with no inbound link: its removal is Fix this first, and it is
the sitemap's orphan.

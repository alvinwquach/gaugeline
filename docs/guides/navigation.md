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

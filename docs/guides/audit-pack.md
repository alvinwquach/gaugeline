# Audit pack: turn a first run into a proposal

A prospect asks what is wrong with their site and what it would cost to put right. The honest answer
takes an evening: run a check, read the findings, sort them into jobs, put your prices on them and write
it up. `gaugeline audit <site> --pack` does the sorting and the writing. It runs the check on the
prospect's site and turns the findings into a pack you can send: a one-page summary for the owner, the
findings grouped into **your own packages** with **your own prices**, what each package leaves out, and
how you would check it worked.

It only looks. Every request is a `GET` or `HEAD` through the same fetcher as the page check, and
nothing is sent anywhere: the pack is two files written into a folder on your machine. The wording of each
finding is the one `gaugeline brief` (the [work order](../no-developer.md)) prints, so a finding reads the
same in the pack, the work order and the digest. There is no model call anywhere in it: the same run and
the same settings give the same pack.

```sh
npx gaugeline audit marlowe-bar.com --pack
```

## A prospect's site is not yours to probe

The pack runs **only the default checks**. They look at the public pages the way a visitor or a search
engine does. They do not ask for `/.env`, `/.git` or admin paths, and they never use a key the site
exposes against its own services. Those are the probing checks, and they stay off unless you pass
`--owner-consent`, or keep a `gaugeline.consent.json` in the folder you run from, for a site you own or
have permission to test. **Run them only on sites you own or have permission to test.** An audit pack for a
new client does not turn them on by itself.

Two things follow from that:

- Keep `gaugeline.consent.json` out of the folder you use for prospects. Gaugeline reads it from the
  folder you run in, so a consent given for one client's site would also count for the next.
- The pack says what was and was not looked at, in its last section: whether the probing checks ran, and
  that the mail records (SPF and DMARC) were not read unless you added `--dns`.

## Your packages

Your packages are in `gaugeline.services.json`, in the folder you run from. Gaugeline never invents a
price: a package has the price and the hours you wrote, and nothing else. Without the file the pack
still works, but it groups the findings by area (search and sharing, visitors, sales and prices, leads,
security and email, launch day) and shows no estimate at all.

| Field                      | What it does                                                                                                                                                                       |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `currency`                 | The currency of every price in the file, as a three-letter code. Default `usd`                                                                                                     |
| `services[].name`          | The package's name, as the client sees it. Each name is used once                                                                                                                  |
| `services[].covers.checks` | Check ids it covers, from the [checks reference](../checks.md). An id Gaugeline does not run is a mistake in the file and stops the run (exit 2) before the site is asked anything |
| `services[].covers.areas`  | Whole areas it covers: `Search & sharing`, `Visitors`, `Sales & prices`, `Leads`, `Security & email`, `Launch day`                                                                 |
| `services[].price`         | `from` and `to`, in whole units of the currency. Equal numbers read as one price                                                                                                   |
| `services[].hours`         | `from` and `to`, in whole hours                                                                                                                                                    |
| `services[].notIncluded`   | What the package leaves out, one line each (up to 20)                                                                                                                              |
| `brand`                    | `name`, `logoUrl` and `contact`, as for `--brand`, `--brand-logo` and `--brand-contact`. The flags replace the file, field by field                                                |

A package needs `covers` and a `price` or `hours` (or both). The rules for grouping are short:

- A finding goes to the **first** package, in file order, that covers it by id or by area. No finding is
  counted twice, so the totals add up.
- A package with nothing to fix on this site is **left out** of the pack. It is not a package you are
  proposing for this client.
- Findings no package covers go under **Other findings**, with no price. The pack says you can quote them
  separately, and the total says it leaves them out.
- The totals are the sums of the ranges you wrote: a price range and an hours range, each added up. A
  package with only hours is named as left out of the price total, and the other way round.

## Example: a bar that books by email

The Corner Bar is an invented client: a neighbourhood bar whose site you did not build. You have not
been hired yet, so you run the audit from your own folder, with your packages in
`gaugeline.services.json`. Two of your packages cover what the check finds, and one image finding falls
under neither.

```json title=gaugeline.services.json
{
  "currency": "usd",
  "services": [
    {
      "name": "Search and sharing tidy-up",
      "covers": {
        "checks": ["canonical-elsewhere", "og-image-missing"]
      },
      "price": {
        "from": 450,
        "to": 700
      },
      "hours": {
        "from": 4,
        "to": 6
      },
      "notIncluded": ["New page copy", "Paid search or ads"]
    },
    {
      "name": "Phone, booking and alt text",
      "covers": {
        "checks": ["viewport", "mailto-cta", "images-alt-missing"]
      },
      "price": {
        "from": 600,
        "to": 900
      },
      "hours": {
        "from": 5,
        "to": 8
      },
      "notIncluded": ["Setting up an online booking system", "A redesign"]
    }
  ],
  "brand": {
    "name": "Harbour Studio",
    "logoUrl": "https://harbour-studio.example/logo.png",
    "contact": "Mia Okafor, 555 0142, harbour-studio.example"
  }
}
```

```sh title=Terminal untested="Runs the built command against the corner-bar fixture with this page's gaugeline.services.json, which the docs runner cannot supply (it runs from the repository folder, and the command writes a folder). packages/cli/src/__tests__/audit-docs.test.ts runs it in a temporary folder and compares the output with the blocks below."
$ npx gaugeline audit cornerbar.example --pack --business "The Corner Bar"
```

```text title=Output
Audit pack for cornerbar.example: 6 things worth fixing.
Wrote gaugeline-audit/audit-pack.html
Wrote gaugeline-audit/audit-pack.md
```

The folder `gaugeline-audit` now holds `audit-pack.html`, which you can send or print, and
`audit-pack.md`, which you can edit first. This is the Markdown, whole:

::: details audit-pack.md for The Corner Bar

```text title=audit-pack.md
# Site audit: The Corner Bar

![Harbour Studio](https://harbour-studio.example/logo.png)

Prepared by **Harbour Studio**. Mia Okafor, 555 0142, harbour-studio.example

Checked https://cornerbar.example/ on 10 Nov 2026.

## Summary

Gaugeline checked cornerbar.example on 10 Nov 2026 and found 6 things worth fixing: 1 to fix first, 2 to fix soon and 3 worth knowing.

### What is at risk

- Search engines treat the page as a copy, so it may never appear in results.
- Visitors have to pinch and zoom to read anything, and Google treats the page as not mobile-friendly.
- The enquiry skips your CRM: it lands in one inbox with no campaign details, nobody else sees it, and visitors without an email program set up can't send it at all.
- Without alt, screen readers read the file name aloud. An empty alt="" tells them to skip a decorative image; a missing one does not.
- WebP and AVIF are usually a quarter to a half smaller for the same picture, so the page loads faster.

### The five to start with

1. **This page tells Google to show a different page** (Fix this first)
   - \<link rel="canonical" href="https://cornerbar.example/menu"\> on https://cornerbar.example/ (differs by path)
2. **This page isn't set up for phone screens** (Fix soon)
   - no \<meta name="viewport"\> on https://cornerbar.example/
3. **Some buttons open an email instead of a form** (Fix soon)
   - Opens an email instead of a form: "Book a table" (mailto:t\*\*\*@cornerbar.example). (https://cornerbar.example/)
4. **Some images have no alt attribute** (Worth knowing)
   - 1 image has no alt: /patio.png (https://cornerbar.example/)
5. **Images use older, heavier file formats** (Worth knowing)
   - 2 of 2 sampled images are JPEG, PNG or GIF only: /taps.png, /patio.png (https://cornerbar.example/taps.png)

## What we would fix, and what it costs

### Search and sharing tidy-up

**Price:** $450–$700. **Time:** 4–6 hours.

- **This page tells Google to show a different page** (Fix this first). The page's canonical tag names a different address as the real one. Done looks like: Each page's canonical tag names its own address.
- **Shared links have no picture** (Worth knowing). The page has no og:image tag. Done looks like: The page has an og:image with a full address, about 1200 by 630 pixels.

**Not included:**

- New page copy
- Paid search or ads

**How we would check it worked:** We run Gaugeline again on cornerbar.example (npx gaugeline cornerbar.example) and confirm that “This page tells Google to show a different page” and “Shared links have no picture” are no longer reported.

### Phone, booking and alt text

**Price:** $600–$900. **Time:** 5–8 hours.

- **This page isn't set up for phone screens** (Fix soon). The page has no viewport meta tag, so phones show it zoomed out as if on a desktop screen. Done looks like: The page head has a viewport meta tag.
- **Some buttons open an email instead of a form** (Fix soon). A contact button ("Talk to an expert", "Get a quote") opens one person's email program instead of a form. Done looks like: Each button opens a form or booking page whose enquiry reaches the CRM.
- **Some images have no alt attribute** (Worth knowing). Some images have no alt attribute at all, not even an empty one. Done looks like: Every img has an alt attribute: a description, or alt="" for decoration.

**Not included:**

- Setting up an online booking system
- A redesign

**How we would check it worked:** We run Gaugeline again on cornerbar.example (npx gaugeline cornerbar.example) and confirm that “This page isn't set up for phone screens”, “Some buttons open an email instead of a form” and “Some images have no alt attribute” are no longer reported.

**Total for the packages above:** $1,050–$1,600, 9–14 hours. The other findings are not included.

## Other findings

No package above covers these, so they have no price here. We can quote them separately.

- **Images use older, heavier file formats** (Worth knowing). Images are served as JPEG, PNG or GIF with no WebP or AVIF version offered. Done looks like: Images are offered as WebP or AVIF through a picture element, srcset or the image component.
  - 2 of 2 sampled images are JPEG, PNG or GIF only: /taps.png, /patio.png (https://cornerbar.example/taps.png)

## What this audit does not include

- Gaugeline looked at the site's public pages the way a visitor or a search engine does. It did not log in, fill in a form or change anything.
- It did not ask for private or admin paths.
- The email records (SPF and DMARC) were not read.
```

:::

Read the pack as the owner would. The summary is plain sentences and five findings with the evidence,
most urgent first. Each package shows your range, what you leave out and the re-run that proves it is
done. Nothing in it is a number you did not write: the only figures are the ones from your file, and the
total.

The address in "Book a table" appears masked (`t***@cornerbar.example`). See
[What is kept out of the pack](#what-is-kept-out-of-the-pack).

## Example: a bakery with nothing to fix

Juniper Bakehouse is an invented client whose site is already in good shape. The pack is short, not
empty: it says so, gives no price, and suggests the re-run.

```sh title=Terminal untested="Runs the built command against the clean fixture with the same gaugeline.services.json. packages/cli/src/__tests__/audit-docs.test.ts runs it in a temporary folder and compares the output with the blocks below."
$ npx gaugeline audit juniperbakehouse.example --pack --business "Juniper Bakehouse"
```

```text title=Output
Audit pack for juniperbakehouse.example: nothing to fix.
Wrote gaugeline-audit/audit-pack.html
Wrote gaugeline-audit/audit-pack.md
```

```text title=audit-pack.md
# Site audit: Juniper Bakehouse

![Harbour Studio](https://harbour-studio.example/logo.png)

Prepared by **Harbour Studio**. Mia Okafor, 555 0142, harbour-studio.example

Checked https://juniperbakehouse.example/ on 10 Nov 2026.

## Summary

Gaugeline checked juniperbakehouse.example on 10 Nov 2026 and found nothing to fix.

The pages it looked at are in good shape, so there is no work to propose today. Running Gaugeline again after each release (npx gaugeline juniperbakehouse.example) keeps it that way.

## What this audit does not include

- Gaugeline looked at the site's public pages the way a visitor or a search engine does. It did not log in, fill in a form or change anything.
- It did not ask for private or admin paths.
- The email records (SPF and DMARC) were not read.
```

## Options

| Flag                     | What it does                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------- |
| `--pack`                 | Required: build the proposal pack. It keeps the command free for other audit modes later           |
| `--business <name>`      | The prospect's business, shown in the heading. Default: the site's host                            |
| `--brand <name>`         | Your name, at the head and foot of the pack                                                        |
| `--brand-logo <url>`     | An `https` address for your logo. Gaugeline never fetches it; the browser that opens the HTML does |
| `--brand-contact <line>` | Your contact line, under your name. It is shown as you typed it                                    |
| `--out <folder>`         | Where `audit-pack.html` and `audit-pack.md` go. Default `gaugeline-audit`                          |
| `--force`                | Replace pack files that exist. Never a folder or a link                                            |
| `--dns`                  | Also read the mail records (SPF and DMARC) and include their checks                                |
| `--owner-consent`        | Run the probing checks as well, on a site you own or have permission to test                       |

There is no price flag: prices come only from `gaugeline.services.json`. The folder must be the one
you ran the command in or one inside it. It is checked, and a pack that is already there is refused
without `--force`, before the site is asked anything. The two files are written together or not at all,
and every path is printed. Exit codes: `0` the pack was written, `2` it could not be (a wrong
settings file, an unwritable folder, a site Gaugeline could not read).

## What is kept out of the pack

The pack may be sent to a prospect, so it is made to be safe to send.

- **No secrets.** Text from the site goes through the same redactor as every finding, so a key-shaped
  string or a secret query parameter is replaced before it reaches a file.
- **No full email addresses.** An address the site shows (a "Book a table" link, a contact line) is
  masked to its first letter and its domain, `t***@cornerbar.example`. Your own `--brand-contact` is
  yours to word and is shown as you typed it.
- **Names, counts and ids only** for anything read from a content system, as in the work order.
- **Escaped text.** A business name, a package name or a line from the site cannot become a heading, a
  link, an image or markup in either file; invisible and bidirectional characters are written out as
  `\u{...}`.
- **A closed HTML file.** `audit-pack.html` has its styles inline, no script, and a content security policy
  that allows nothing but those styles and an `https` image. The only thing it can load is your logo,
  and only if you gave an address for one.

## What it does not do

- It does not price anything. Without your settings there is no estimate, and a package without a price
  or hours is a mistake in the file.
- It does not send the pack. It writes two files and stops.
- It does not probe a site you have no permission to test (see above).
- It does not rewrite findings. The sentences are the checks' own; edit the Markdown if you want your
  voice.

What is requested, and from where, is the same as for the page check:
[Privacy and safety](../privacy.md#audit-pack-gaugeline-audit-pack).

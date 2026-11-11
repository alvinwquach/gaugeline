# When you don't have a developer

Your developer moved on, or is busy. Here's how to find out what's wrong and hand it to whoever comes next.

You don't need to understand any of this to use it. One command reads your live website and writes a work order in plain English. Nothing on the site changes.

<!-- fixture: corner-bar -->

```sh title=Terminal
$ npx gaugeline brief yoursite.com --business "The Corner Bar" --rate 110 --hours-per-point 1.5
```

::: details The work order it prints for The Corner Bar (an invented bar)

```text title=Output
# Work order: The Corner Bar

Checked https://yoursite.com/ at 2026-01-01T00:00:00.000Z.

## What is worth paying to fix

6 items are worth paying to fix, 8 points in all.

| #   | Item                                            | Size   | Points |
| --- | ----------------------------------------------- | ------ | -----: |
| 1   | This page tells Google to show a different page | Small  |      1 |
| 2   | This page isn't set up for phone screens        | Small  |      1 |
| 3   | Some buttons open an email instead of a form    | Medium |      3 |
| 4   | Some images have no alt attribute               | Small  |      1 |
| 5   | Images use older, heavier file formats          | Small  |      1 |
| 6   | Shared links have no picture                    | Small  |      1 |

At 1.5 hours per point, that's roughly 10–16 hours (about $1,056–$1,716 at $110/hour).

Small is 1 point, Medium 3 and Large 8. Points say how big a fix is. Whoever quotes the work turns them into time and money, because the same fix is minutes in a shared component and an afternoon when it is hardcoded in twelve places, and each item says what changes its estimate.

## 1. This page tells Google to show a different page

**Size:** Small (1 point). **Priority:** Fix this first.

**What is wrong:** The page's canonical tag names a different address as the real one.

**Why it matters:** Search engines treat the page as a copy, so it may never appear in results.

**What done looks like:** Each page's canonical tag names its own address.

**Evidence:**

- \<link rel="canonical" href="https://yoursite.com/menu"\> on https://yoursite.com/ \(differs by path\)

**What changes the estimate:** A canonical that comes from one shared SEO component is a single edit. Ones set by hand in the CMS are one edit per page.

## 2. This page isn't set up for phone screens

**Size:** Small (1 point). **Priority:** Fix soon.

**What is wrong:** The page has no viewport meta tag, so phones show it zoomed out as if on a desktop screen.

**Why it matters:** Visitors have to pinch and zoom to read anything, and Google treats the page as not mobile-friendly.

**What done looks like:** The page head has a viewport meta tag.

**Evidence:**

- no \<meta name="viewport"\> on https://yoursite.com/

**What changes the estimate:** A template shared by every page is one edit. Pages built with different templates are one each.

## 3. Some buttons open an email instead of a form

**Size:** Medium (3 points). **Priority:** Fix soon.

**What is wrong:** A contact button \("Talk to an expert", "Get a quote"\) opens one person's email program instead of a form.

**Why it matters:** The enquiry skips your CRM: it lands in one inbox with no campaign details, nobody else sees it, and visitors without an email program set up can't send it at all.

**What done looks like:** Each button opens a form or booking page whose enquiry reaches the CRM.

**Evidence:**

- Opens an email instead of a form: "Book a table" \(mailto:tables@cornerbar.example\). (https://yoursite.com/)

**What changes the estimate:** A form and its CRM connection are built first if there is none, then each button is repointed.

## 4. Some images have no alt attribute

**Size:** Small (1 point). **Priority:** Worth knowing.

**What is wrong:** Some images have no alt attribute at all, not even an empty one.

**Why it matters:** Without alt, screen readers read the file name aloud. An empty alt="" tells them to skip a decorative image; a missing one does not.

**What done looks like:** Every img has an alt attribute: a description, or alt="" for decoration.

**Evidence:**

- 1 image has no alt: /patio.png (https://yoursite.com/)

**What changes the estimate:** Images inside CMS content are edited one by one.

## 5. Images use older, heavier file formats

**Size:** Small (1 point). **Priority:** Worth knowing.

**What is wrong:** Images are served as JPEG, PNG or GIF with no WebP or AVIF version offered.

**Why it matters:** WebP and AVIF are usually a quarter to a half smaller for the same picture, so the page loads faster.

**What done looks like:** Images are offered as WebP or AVIF through a picture element, srcset or the image component.

**Evidence:**

- 2 of 2 sampled images are JPEG, PNG or GIF only: /taps.png, /patio.png (https://yoursite.com/taps.png)

**What changes the estimate:** A site with no image pipeline needs one set up first.

## 6. Shared links have no picture

**Size:** Small (1 point). **Priority:** Worth knowing.

**What is wrong:** The page has no og:image tag.

**Why it matters:** When the page is shared in a chat or a social post, it shows as a plain link with no picture, which fewer people click.

**What done looks like:** The page has an og:image with a full address, about 1200 by 630 pixels.

**Evidence:**

- no og:image on https://yoursite.com/

**What changes the estimate:** Making the pictures is the cost if none exist.
```

:::

That printed the work order on screen. To keep it as a file to send, add `--out`:

```sh title=Terminal untested="It writes a file and prints nothing on stdout, so there is no output to compare. The text is the one printed above, and packages/cli/src/__tests__/brief.test.ts checks the file."
$ npx gaugeline brief yoursite.com --business "The Corner Bar" --rate 110 --hours-per-point 1.5 --out work-order.md
```

| Flag                    | What it does                                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--business "The Bar"`  | Puts the business's name in the heading. Without it the heading names the site's address.                                                         |
| `--hours-per-point 1.5` | Adds a range of hours, never one number. Without it the work order gives points only.                                                             |
| `--rate 110`            | What an hour costs, in whole US dollars, for the range in money. It only does something together with `--hours-per-point`.                        |
| `--out work-order.md`   | Writes the work order to a file in the folder you run from, and tells you where. It never replaces a file that is there unless you add `--force`. |

## What the work order contains

- How many items are worth paying to fix, and how big each one is
- Each item: what's wrong, why it matters, and what "done" looks like
- The evidence, so a developer can start without re-diagnosing it
- What changes the estimate, so nobody quotes blind

The most urgent items come first, and within a level the smallest. Twelve images with no description are one item with twelve places to look, not twelve items: it is one job. Anything Gaugeline found but cannot size (a check this version no longer has) is listed at the end under "Not sized" and is left out of the total, with a note saying so.

## Why it doesn't give you hours

Two developers quote the same fix differently, and both can be right: one link built in a shared component is minutes, the same link hardcoded in twelve places is an afternoon. So the work order sizes each item instead — Small (1 point), Medium (3), Large (8) — and leaves the conversion to whoever is quoting.

| Size   | Points | Means                                                                                   |
| ------ | ------ | --------------------------------------------------------------------------------------- |
| Small  | 1      | A contained change in one place, with an obvious way to confirm it                      |
| Medium | 3      | Touches a component, a setting or a third-party system, and needs checking across pages |
| Large  | 8      | Changes something shared, or needs a decision or content from someone else first        |

With `--hours-per-point` the work order adds one sentence, the one in the example above:

```text
At 1.5 hours per point, that's roughly 10–16 hours (about $1,056–$1,716 at $110/hour).
```

That is 8 points at 1.5 hours a point, which is 12 hours, shown as a range from 80% to 130% of it (9.6 to 15.6 hours, rounded to whole hours). The money is the same range at your hourly rate. It is always a range: a single number would promise more than a look from outside can know.

Each size is decided once, by whoever wrote the check, from the kind of fix it is: it is never worked out from how bad a finding is, so a "Fix this first" item can be Small. Every check's size, what "done" looks like and what changes its estimate are on [Every check](/docs/checks).

::: info
To find your own number: take an item you've already done, divide the hours it actually took by its points, and use that. It gets more accurate every time you check it against what really happened.
:::

## How to use it

1. Run the command, or ask anyone technical to run it once.
2. Send the file to a developer, an agency, or three of them for quotes.
3. Ask them to re-run the same command when they're done and send you the result.

::: info
The last step is the point: the same check that found the problem proves the fix. You don't have to take anyone's word for it.
:::

- **If you own the site:** This is the page for you. It turns "something feels wrong with the website" into a list with prices attached.
- **If you run marketing:** Useful for scoping: you can see whether a problem is an afternoon or a project before asking for budget.
- **If you edit content:** If you publish content and nobody maintains the site, run this monthly and send it on.
- **If you build the site:** `gaugeline brief` is also an MCP tool, so an assistant can produce the work order and you can edit it before it goes out.

## If you build sites for clients

A clinic you built a site for in the spring asks what it would cost to "sort out the website". Run the work order with your own number and send the file:

```sh title=Terminal untested="The output depends on the clinic's live site, so there is nothing fixed to compare. The same command runs against an invented bar above."
$ npx gaugeline brief lakeside-physio.example --business "Lakeside Physio" --hours-per-point 1.5 --rate 95 --out work-order.md
```

The clinic reads "7 items, 11 points, roughly 13–21 hours" and what each one is, instead of an invoice with one line. When you finish, run the same command again and send the new file: the items that are gone are the proof.

## What it can't tell you

It reads what's public. It can't see your hosting bill, your contracts, or anything behind a password, and the effort ranges are estimates from similar work rather than a quote. Treat them as a starting point for the conversation.

The work order holds what the report holds and nothing more: the findings and their evidence, with any query string left off an address. It never contains a key or a password. If you connect Sanity, the evidence names fields, types and counts, not what your editors wrote. It is made by templates from the findings, with no model involved, so the same run gives the same text. Words from the checked site are shown as plain text, never as links or markup.

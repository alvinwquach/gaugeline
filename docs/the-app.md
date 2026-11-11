# Open the app

Run checks from a browser tab on your own computer, the way dbpeek opens a database.

```sh title=Terminal untested="gaugeline open runs until Ctrl+C: open.test.ts runs the built bin and checks these two lines."
$ npx gaugeline open
Gaugeline is running at http://localhost:4817/?s=…
It's only reachable from this computer. Press Ctrl+C to stop.
```

The link opens in your browser (not with `--no-open`, and not in CI). If port 4817 is taken, the app
uses the next free one, up to 4826, and the link says which. If all ten are taken, it stops with exit
code 2 and says so.

The address is optional. With one (`npx gaugeline open yoursite.com`), its check runs first and the
terminal shows its progress, the same lines a plain check prints, before the link. Without one, enter
an address in the app. You can check as many pages as you like in one session; each one appears in
the sidebar, oldest first. A session keeps the last 50 checks, in memory only: Ctrl+C ends it and
they are gone.

The address you enter can be on your own computer or network (`localhost:3000`, a staging machine
at `192.168.1.20`), the way your own terminal can reach it. Where its pages point is another
matter: a redirect or a link to some other private address is not followed.

## Check a page

Type an address in the box at the top and press Enter. If the address isn't one Gaugeline can read,
the reason appears next to the box, in a sentence, and what you typed stays so you can fix it. The
box is cleared only once the check has started.

![The app after two checks: the sidebar lists both pages, and the Overview of the second shows how many problems it has at each level, the three to start with, and what looked right.](/img/app-overview.png)

- **The sidebar** lists every page you have checked this session, oldest first, each with its
  address, whether it is still checking, done or could not run, and how many problems it has at
  each level. The page you check next is opened for you. Select any other to look at it again: its
  results are already in the app, so nothing is requested from the site a second time.
- **Progress** appears while a check runs, one line at a time, the same lines a terminal check
  prints. Screen readers announce each as it arrives.
- **The address bar** keeps your place. It reads `#/<run>/<view>`, so reloading the page, or going
  back, returns to the same page and view. If the run it names is gone (you restarted
  `gaugeline open`), the app opens the newest one instead.

The Overview is the first view. It shows how many problems there are at each of the three levels
(Fix this first, Fix soon, Worth knowing; see [Reading the report](/docs/reading-the-report)), the three to start with,
every check that passed, and how much of the site was read. A page with nothing to fix still lists
what was checked. Everything that comes from the page you checked, its title, an address, a line of
evidence, is shown as plain text, so a page can't put markup in the app.

The same page checked from the terminal finds the same things: the Overview starts with the first three, and the sidebar counts the rest by level.

<!-- fixture: images -->

```sh title=Terminal
$ npx gaugeline shop.example
```

```text title=Output
✗ Some images on this page don't load
    <img src="./missing.png"> returned 404
! Images are requested at an enormous width
    1 image is offered at 3840 pixels or wider: /hero.jpg (3840w)
! Some images are very large files
    ./heavy.jpg is 879 KB (Content-Length 900,000)
! Images still load from an old WordPress site
    1 image loads from ./: ./old-sign.jpg
· Some images have no alt attribute
    2 images have no alt: ./swatch-0.png, ./swatch-1.png
· Images use older, heavier file formats
    16 of 20 sampled images are JPEG, PNG or GIF only: ./heavy.jpg, ./old-sign.jpg, ./divider.png and 13 more
? image-optimizer-allowlist-wide could not be checked: this page resizes images through the Next.js image address, and whether that address fetches only the hosts you listed is not visible from the page; add settingsFiles to gaugeline.images.json (the images settings of your framework), or run the probe on a site you own (./image)
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

Checked 20 of 41 images.
6 to look at, 1 to fix first.
```

## Problems

The Problems view lists every finding of the page you have open, grouped as Fix this first, Fix
soon and Worth knowing, in the order of the result.

![The Problems view with one finding open: the plain-English text for what was found, why it matters and how to fix it, the evidence from the page, and the technical detail one click away.](/img/app-problems.png)

- **Filters** sit above the list: one row for urgency and one for area (Search & sharing, Visitors,
  and the rest of the areas in [Reading the report](/docs/reading-the-report)). They are toggle
  buttons with the number of findings next to each. Choose none and you see everything. Choose
  two urgencies and you see either; choose an urgency and an area and you see only what is both.
  An area with no findings in this page's check is not offered. Switching to another page starts
  the filters over.
- **Open a finding** with a click, or Enter or Space on the keyboard. It shows what was found, why it
  matters and how to fix it, in plain English, then the evidence from the page. One finding is open
  at a time, and it is kept in the address bar (`#/<run>/problems/<number>`), so reloading returns
  to it.
- **Show technical detail** reveals the one line a developer wants: what the check looked at and what counted as a
  problem. It is closed until you press it.
- **Copy note for your developer** puts a plain-text note on the clipboard and says so. If your
  browser will not let a page use the clipboard, the note is shown in a box, already selected, with
  a line telling you to copy it by hand.
- **Nothing to fix** says so, and points to the Overview for what was checked and what looked right.

The note always includes the technical line, and has no formatting, so it reads the same in email,
Slack, Jira or a text message. This is the note for the broken image above:

```text title=Copied note
Some images on this page don't load

Page: https://shop.example/img/missing.png

Why it matters:
Visitors see an empty box or a broken-image icon where a product photo or a diagram should be.

How to fix it:
Upload the image again, or point the img at its current address. For /_next/image, check the file named by url= exists.

Technical detail:
a sampled same-site img src answers 4xx or 5xx (images on other hosts are not requested); a refusal (401, 403, 429, 503 with Retry-After) is listed as could not check

Evidence:
<img src="/img/missing.png"> returned 404

Check: images-broken
```

A section with nothing in it, such as the evidence for a finding that has none, is left out whole.
The evidence is the page's own words, copied as they are.

## Pages checked

Pages checked lists every address the check requested, and what each one answered, so you can
verify a finding with your own eyes: the page itself, each step of a redirect, the links, images,
sitemap pages, feeds and JavaScript files it sampled, and the few other pages and files it read
along the way (`robots.txt`, the sitemap, `llms.txt`).

![The Pages checked view: a table of every address the check requested, one row each, with its kind, how it was asked for, what it answered and how long that took. Rows that did not end in a 2xx are marked, and a footer says how much of each kind was read.](/img/app-pages.png)

- **One row for each request.** Rows are grouped by kind, in the order Page, Link, Image, Sitemap page, Feed,
  JavaScript file, Other page, Other and Read-only query, and within a kind in the order they were requested. A
  redirect is not tucked under its first address: each step is a row, and every row that moved
  says where to, so you read the chain from top to bottom. The Request column says whether the
  check asked with GET or HEAD. The one other request is a Read-only query, a POST that asks a
  platform's own API a question (ADR-0006): its row names the allowlist entry that let it
  through, and the body and the key are never shown.
- **The answer** is a short phrase for the status: Loaded (any 2xx), Moved to an address, Not found
  (404 and 410), Server error (5xx), Refused (401, 403 and 429: the site said no, which is not the
  same as broken), or No answer when the site did not reply in time. An address that would have led
  to a private or local address you did not type is Not followed (private address), and nothing is
  sent to it.
- **Only problems** hides every row that ended in a 2xx. What is left is a redirect, an error or
  no answer. The count above the table follows ("Showing 3 of 21 addresses"). A redirect is
  listed because it is not a 2xx; it is often fine.
- **The footer** states how much was read against the limits that are published on
  [Security](/docs/security#how-much-a-run-requests), for example "24 of up to 30 same-site links (52 found)".
  Other addresses have no limit; they are the few files every site has and anything else a check
  asked for.
- **Addresses are text, not links.** They come from the page you checked, which may be broken or
  hostile, so no address here can be clicked: copy one to open it. An address that starts with
  `javascript:` or contains markup is shown as it is.

This is the table for a small pottery studio, as the app lists it (the time of each request is in
the app and left out here, because it is different every run):

```text title=Pages checked rows
Page             GET   https://studio.example/                 Loaded
Link             HEAD  https://studio.example/moved            Moved to https://studio.example/moved-again
Link             HEAD  https://studio.example/moved-again      Moved to https://studio.example/about
Link             HEAD  https://studio.example/about            Loaded
Link             HEAD  https://studio.example/gone             Not found
Link             HEAD  https://studio.example/busy             Server error
Image            HEAD  https://studio.example/img/mug.png      Loaded
Image            HEAD  https://studio.example/img/missing.png  Not found
Sitemap page     HEAD  https://studio.example/                 Loaded
Sitemap page     HEAD  https://studio.example/about            Loaded
Sitemap page     HEAD  https://studio.example/shop             Loaded
Feed             GET   https://studio.example/feed.xml         Loaded
JavaScript file  GET   https://studio.example/app.js           Loaded
Other page       GET   https://studio.example/about            Loaded
Other page       GET   https://studio.example/shop             Loaded
Other page       GET   https://studio.example/moved            Moved to https://studio.example/moved-again
Other page       GET   https://studio.example/moved-again      Moved to https://studio.example/about
Other page       GET   https://studio.example/about            Loaded
Other page       GET   https://studio.example/gone             Not found
Other            GET   https://studio.example/llms.txt         Not found
Other            GET   https://studio.example/robots.txt       Loaded
Other            GET   https://studio.example/sitemap.xml      Loaded
```

The rows are what the check really requested: for this site, the server behind it saw exactly
that many requests. The page links to `/moved`, which goes to `/moved-again` and then to `/about`,
so it is three rows, two of them "Moved to".

## Search data

Search data shows what the page declares to a search engine, as read without running any
JavaScript, the way a crawler first receives it.

![The Search data view: the title and canonical, the number of readable words and the first of them, and each structured data block as a tree of types and fields, with one block that could not be read shown as plain text with the parser's message.](/img/app-search-data.png)

- **Title and canonical.** A page with none says Not set; one that has the tag with nothing in it
  says Empty. They are different problems.
- **Readable words** counts the words a visitor can read before any JavaScript runs, and the page
  shows the first 200 of them in order. A page with none says so, and points to
  "Google sees an almost empty page" in [Problems](#problems).
- **Structured data** lists each block in the order it appears, as a tree of types and fields you
  can open and close: "Product, offers, price" without the braces. The first three levels start
  open and anything deeper starts closed, so a large block stays readable. A block that could not
  be parsed is shown as its raw text, with the parser's message.
- Everything shown is text from the page, including a value that looks like markup. Nothing here
  is requested again: it is what the check already read.

For the same studio:

```text title=Search data
Title: Larkspur Pottery Studio
Canonical: https://studio.example/
Readable words: 57
First 8 of them: About the studio Shop Classes Gift cards Waiting

Block 1: Product
  @context: https://schema.org
  @type: Product
  name: Speckled mug
  offers: Offer
    @type: Offer
    price: 24.00
    priceCurrency: USD

Block 2: Organization, WebSite
  @context: https://schema.org
  @graph
    0: Organization
      @type: Organization
      @id: https://studio.example/#org
      name: Larkspur Pottery Studio
    1: WebSite
      @type: WebSite
      @id: https://studio.example/#site
      name: Larkspur Pottery

Block 3: Could not be read
  Expected double-quoted property name in JSON at position 62 (line 1 column 63)
  { "@type": "LocalBusiness", "name": "Larkspur Pottery Studio",
```

## Leaks & access

Leaks & access gathers what the checks already found about three things that go wrong when a site
is handed over: a Sanity dataset anyone can read, a secret key shipped to every visitor in the
site's JavaScript, and a staging or preview copy that answers publicly. It runs no check of its
own and asks the site for nothing: it shows what the run read, and links each finding to
[Problems](#problems).

![The Leaks & access view for an invented wine bar: the Sanity project and dataset and that it is public, the six type names it holds, a table of the JavaScript files scanned with two masked keys in one of them, and the staging and preview addresses found.](/img/app-leaks.png)

Say a freelancer built the wine bar's site on Sanity, Next.js and Vercel last spring, and the owner
asks "is anything of mine out in the open?" before the new menu goes live. This is what the four
panels say for that site:

```text title=Leaks & access
Sanity dataset
  Project mo7h1an7, dataset production: Public (it answers questions without a token)

Types it holds
  187 documents in 6 types
    event
    menu
    page
    post
    venue
    wineList

JavaScript scanned for keys
  /assets/vendor.js       Nothing found
  /assets/app.js          Stripe secret key sk_liv…00; Stripe secret key rk_liv…d0
  /assets/old-booking.js  Not scanned. Could not be read (status 404).
  2 of up to 15 JavaScript files scanned

Staging copies
  https://moth-lantern-git-menu-studio.vercel.app/menu  Linked from the page. Gaugeline did not request it.
  https://staging.moth-lantern.example/  Answers publicly, and does not ask search engines to stay away.
```

- **Sanity dataset.** Whether the dataset the page's images come from is public or private, with the
  project id and dataset name as they appear in the image address. A page that does not use
  Sanity says so in one line. A dataset that could not be read says that, and is never shown as
  private.
- **Types it holds.** Only for a public dataset: how many documents it has and the names of their
  types, in a list that scrolls inside its panel when there are many. The check asks one
  question, so the count is for the whole dataset, not for each type. There is no way to open a
  document from here, and none is ever downloaded: it is only the number of documents and the
  names of their types. See [Privacy](/docs/privacy#sanity-datasets).
- **JavaScript scanned for keys.** One row for each file the check scanned, up to the published
  limit of 15 (see [Security](/docs/security#how-much-a-run-requests)), with Nothing found or the
  kind of key. A key is shown as the check emits it, its first 6 and last 2 characters, and the
  whole value never reaches the app: it is cut down before the result exists (a Contentful preview token shows no characters at all, only the kind and the place). To find the key,
  open the file the row names and search for those characters. A file that could not be read says
  so instead of Nothing found, and a file longer than the read limit says only its start was read.
  The footer states the sample ("2 of up to 15 JavaScript files scanned"), and says how many more
  files on the page were not scanned when there are more than 15.
- **Staging copies.** Each staging or preview address found, and whether it answers publicly: the
  links on the page to a temporary address (`vercel.app`, `netlify.app`, `pages.dev`), which are
  not requested, and the one request the check makes to `staging.` followed by your domain.
- **Every finding is linked.** A panel with a matching finding links to it in Problems.
- **A check that did not run** says why, in the words of the result (a page that refused the
  request, for example), and never shows an all clear for something that was not checked.
- Everything shown is text from the page, including a type name that looks like markup. An
  address here is never a link.

## Download the report

Above the views, next to their names, **Download the report** saves the page you have open as
`gaugeline-report.html`: the same one-file report that `npx gaugeline yoursite.com` writes in your
folder, byte for byte, with its styles inline and nothing loaded from anywhere. It is only offered
once the check has finished. Save it, attach it to an email, or hand it to the client.

It is a plain link to a file, so it works with the keyboard (Tab, then Enter), a right-click and
"Save link as", and with scripts switched off. The file name is always `gaugeline-report.html`,
whatever the page is called, so a page title or address can never end up in it. If the browser opens
the file instead of saving it, it opens as a page of its own with no scripts and no way to reach the
app. The app keeps nothing of it: the file is built from the check's result when you ask.

Say you have built a website for a tavern and checked it before the weekend. The report names the
three things to fix first and the one to look at, with why each matters and how to fix it, and the
tavern's owner can read it without Gaugeline installed. What the owner would be sent for the
tavern's example run, in the order of the report:

```text title=Example tavern run
✗ The page and the calendar disagree about an event
    "Trivia Night" on 2026-11-12 (America/Los_Angeles): start: the page says 19:00, the calendar says 19:30
✗ The page still promotes an event that already happened
    the "next" card "Next up Darts league final, Sunday 1 November, 8 PM" is dated 2026-11-01T20:00:00-07:00
✗ Your calendar shows the wrong hour on some phones
    1 of 3 events in /calendar.ics have no time zone: "Darts league" DTSTART:20261119T200000
· Some events are missing details search engines need
    "Karaoke" has no eventStatus
```

## Try it with example results

```sh title=Terminal untested="gaugeline open --demo runs until Ctrl+C: open-demo.test.ts runs the built bin and checks these lines."
$ npx gaugeline open --demo
Gaugeline is running at http://localhost:4817/?s=…
It's only reachable from this computer. Press Ctrl+C to stop.
This is the demo: example results about invented sites. Nothing is checked and nothing is requested.
```

`--demo` starts the same app with three finished example checks: the tavern above, a wine bar whose
Sanity dataset is open to anyone, and a pottery studio with broken links and a broken image. Every
view works on them, so you can look at the Problems, Pages checked, Search data and Leaks & access
views, and download a report, before you point Gaugeline at a client's site.

![The demo: a banner reading Example results sits under the address box, which is switched off. The sidebar lists three example checks and the Overview shows the pottery studio's, with Download the report beside the views.](/img/app-demo.png)

- **Nothing is requested from any site.** The results are stored in the package, about invented
  sites at `shop.example`, `wine-bar.example` and `tavern.example`, and the demo makes no outgoing
  connection at all. It works with the computer offline.
- **The address box is switched off.** The banner says why: "This is the demo. Run npx gaugeline
  open yoursite.com to check a real page." A demo and a real session are never mixed in one list,
  so a report about an invented site can't be mistaken for one about a client's.
- **Everything else is the same.** The one-time key, the session cookie and the checks on where a
  request comes from all apply as they do in a normal session.
- `--demo` takes no address, and can't be combined with another way of starting: `gaugeline open
--demo shop.example` and `gaugeline open --demo --ads ads-export.csv` each stop with exit code 2.

## Ads

`gaugeline open --ads ads-export.csv` starts the app with one run, made from an export of your ads
instead of from an address. It adds an **Ads** view, and the run appears in the sidebar under the
file's name, never its folder. The view leads with how much of the spend went to pages with
problems, out of the total, and below it lists each landing page with its ads, its spend and what
was found. Each finding opens in [Problems](#problems), where it can be copied as a note.

![The Ads view for a tapas bar's autumn campaign: $1,150.74 of $3,155.24 went to pages with problems, and a table of four landing pages with their ads, spend and findings, the page that does not load first.](/img/app-ads.png)

[Ad landing pages](/docs/ad-landing-pages#in-the-app) has a worked example for a tapas bar and says
how each row is worked out. What matters for the app:

- **The file is read once, at the start, from the path you typed.** There is no upload box and no
  address that accepts a path, so a web page can't make the app read a file. To look at another export,
  stop the app and run the command again.
- **A file that can't be used stops it before it starts.** A missing or unreadable file, or one with
  no link column or no amount-spent column, exits with code 2 and the ads command's message.
- **`--ads` takes no address**, and can't be combined with `--demo`.
- **Money is shown from whole cents.** Amounts are added as whole numbers of the currency's smallest
  unit and formatted for your language at the end. An export that mixes currencies gets one summary and
  one table for each currency, and amounts in different ones are never added together.
- **Download the report** appears only when the ads command makes a report for the run.

::: warning Findings come with the checks
`gaugeline open --ads` reads the export, groups its ads by landing page and asks each page once for the
one check that exists so far: whether the campaign tags survive the redirects. The other checks (a page
that does not load, sold out, placeholder text) arrive after it, one at a time. Until then the findings
column lists tag losses only, and a page with nothing listed has had that check, not all of them.
:::

## Coming in version 0.2

Three more views are listed after Leaks & access: **Page cost**, **Automatic messages** and
**Content**. They need your Sanity login, which arrives in version 0.2, so today each one is switched
off. They are listed anyway so the app agrees with this page, and so you can see what is coming.

Say you built a physiotherapy clinic's site on Sanity, Next.js and Vercel, and the receptionist asks
why the booking page feels slow and whether anything goes out by itself when she publishes a new
timetable. This is the navigation for a clinic's page run, as the app lists it, and what each of the
three views will show when it arrives:

![The demo opened on Page cost: the navigation lists Overview, Problems, Pages checked, Search data and Leaks & access as links, then Page cost, Automatic messages and Content in muted text, each with "Needs your Sanity login. Coming in version 0.2." under it. The panel below says the same and one sentence about what Page cost will show.](/img/app-coming-soon.png)

```text title=Views
Overview
Problems
Pages checked
Search data
Leaks & access
Page cost           Disabled. Needs your Sanity login. Coming in version 0.2.
                    Page cost will show what each page asks Sanity for, compared with what it shows.
Automatic messages  Disabled. Needs your Sanity login. Coming in version 0.2.
                    Automatic messages will show things Sanity does by itself when you publish.
Content             Disabled. Needs your Sanity login. Coming in version 0.2.
                    Content will show everything on your site as a table, with the pages each item appears on.
```

- **A switched-off view is a button you can still reach with the keyboard.** Tab stops on it and a
  screen reader says its name, then why it is off. Pressing it, with the mouse, Enter or Space,
  does nothing: there is nothing behind it yet.
- **Its address still opens a panel.** `#/<run>/pageCost`, `#/<run>/automaticMessages` and
  `#/<run>/content` show the view's name, the note and the sentence above. There is no table, no
  number and no example, because the app shows real results or says what is coming.
- **Nothing is requested.** The panels make no request to Sanity or to your site, and nothing in
  the app can switch a view on: not a setting, not the address, not an environment variable. They
  turn on in version 0.2 when the release switches them on.
- **The demo and `--ads` runs.** `npx gaugeline open --demo` lists the same three, switched off:
  example results never turn them on. An ads run (`gaugeline open --ads`) has its own two views
  and lists none of them.

## Works offline

The app is part of the `gaugeline` package. Installing or running it with `npx` downloads the app
with it, and `gaugeline open` makes no download of its own: once the package is on your computer, the
app opens with no internet connection (checking a site still needs to reach that site). The page
loads nothing from any other address, and the browser is told to refuse it if it tries: scripts,
styles, fonts and requests may only come from the app itself.

## What's in it

| View                                   | Shows                                                                                                                                        |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Overview                               | Counts by urgency, where to start, what looked right, and how much was checked                                                               |
| Problems                               | Every finding, filterable. Open one for why it matters, how to fix it, and a copy-ready note for your developer                              |
| Pages checked                          | Every address the check tested, and what it answered: the page, each redirect step, links, images, sitemap pages, feeds and JavaScript files |
| Search data                            | The title, canonical, readable words and structured data the page declares, as read without JavaScript                                       |
| Leaks & access                         | Whether the Sanity dataset is public, which types it holds, JavaScript scanned for keys, and staging copies                                  |
| Ads                                    | With `gaugeline open --ads`: the landing pages of an ads export, the spend that went to pages with problems, and each page's findings        |
| Page cost, Automatic messages, Content | Needs your Sanity login. Coming in version 0.2.                                                                                              |

## Private to your computer

- The app listens on 127.0.0.1 only, so nothing else on your network can reach it.
- The link in your terminal carries a one-time key, made new each time and printed only there. Without
  it, every request is refused. The link works once: opening it swaps the key for a session cookie
  and takes the key out of the address bar. To open the app in another browser or a private window,
  restart `gaugeline open`.
- Requests that claim to come from another website are refused, so a page open in another tab can't
  drive it: the app answers only to `localhost` and `127.0.0.1` on its own port (which also stops a
  hostile name that resolves to your computer), and refuses any other Origin and any cross-site
  request.
- The app's files are checked against a list of hashes when it starts. If one differs, or the app
  is missing from the package, `gaugeline open` stops with exit code 2 and a one-line message, and
  reinstalling fixes it.
- Press Ctrl+C and it's gone: the port is closed, open connections end, and nothing is saved.

::: info
Want to see it first? [Open the live demo](https://claude.ai/artifact/MwQmr83pa7xZdkAKvGBcNH) with example results.
Or run `npx gaugeline open --demo` to open the same example results in the app on your own computer: nothing is requested from any site.
:::

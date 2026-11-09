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

## Works offline

The app is part of the `gaugeline` package. Installing or running it with `npx` downloads the app
with it, and `gaugeline open` makes no download of its own: once the package is on your computer, the
app opens with no internet connection (checking a site still needs to reach that site). The page
loads nothing from any other address, and the browser is told to refuse it if it tries: scripts,
styles, fonts and requests may only come from the app itself.

## What's in it

| View                                   | Shows                                                                                                           |
| -------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Overview                               | Counts by urgency, where to start, what looked right, and how much was checked                                  |
| Problems                               | Every finding, filterable. Open one for why it matters, how to fix it, and a copy-ready note for your developer |
| Pages checked                          | Every address the check tested, and what it answered                                                            |
| Search data                            | The title, canonical, readable words and structured data the page declares                                      |
| Leaks & access                         | Whether the Sanity dataset is public, which types it holds, JavaScript scanned for keys, and staging copies     |
| Page cost, Automatic messages, Content | Need your Sanity login. Coming in version 0.2                                                                   |

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
:::

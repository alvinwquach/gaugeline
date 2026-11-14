# Rendered pages: reading what a script adds

Gaugeline reads the HTML a site sends and never runs the page. Some things only exist after the page's scripts
run: a price filled in by a script, a menu a script builds, the order links get on a small screen. For those,
Gaugeline can load the page in a browser **you installed**, read what it did, and hand that to the checks that
need it. It is off unless you ask for it, and it is read-only: the browser can look, and it cannot send.

**Today.** The renderer is built and tested (row render-01) and `--renderer playwright` turns it on. With it, the
click checks for your [tracking plan](./guides/click-events.md) click the plan's links in the browser (row
render-02, below). With `--attribution` it also loads the page with reduced motion, without JavaScript and without
third-party scripts and says which change moves the load ([Speed attribution](./guides/speed-attribution.md)). **Not built.** The layout, contrast and calculator checks. **Not accepted.** A hosted
renderer, a service that renders the page on someone else's machine and Firecrawl: the owner decided on 13 Nov
2026 that the only renderer is the browser on your own machine (decision record 0009,
`docs/adr/0009-rendered-checks.md` in the repository).

## Turn it on

```text title="Terminal" untested="Needs a browser installed on the machine. packages/renderer/src/__tests__/e2e.test.ts runs the renderer on the invented bakery in a real browser, and packages/cli/src/__tests__/renderer-docs.test.ts runs the commands on this page and compares what they print."
$ npx gaugeline bakery.example --renderer playwright
```

`--renderer` names one renderer and `playwright` is the only one. Without it, Gaugeline loads no browser code at
all (a test asserts that a normal run never imports it). The driver, `playwright-core`, is an optional peer
dependency of Gaugeline: it is yours to install, in the project that runs Gaugeline.

```sh
npm install --save-dev gaugeline playwright-core
npx playwright install chromium
```

**Gaugeline never downloads a browser.** It looks for one in this order and uses the first it finds:

| Order | Where                                                                                                        |
| ----- | ------------------------------------------------------------------------------------------------------------ |
| 1     | The file named by `GAUGELINE_BROWSER_PATH`, if you set it. If it is not there, that is the end: you named it |
| 2     | The browser Playwright installed (its own folder, or the one `PLAYWRIGHT_BROWSERS_PATH` names)               |
| 3     | Google Chrome, Chromium or Edge, where each system keeps them                                                |

If there is no driver or no browser the run still finishes. It says why, once, and how to fix it, and a check
that needs a rendered page says **could not check**: never a pass, never a finding.

```text title="Output"
warning: rendering is on, but GAUGELINE_BROWSER_PATH is set to ./chrome, and there is no file there. Checks that need a rendered page say could not check.
Gaugeline never downloads a browser. Install one yourself, then run again:
  npx playwright install chromium     (Playwright's own folder; PLAYWRIGHT_BROWSERS_PATH moves it)
or install Google Chrome, Chromium or Edge the usual way, or set
GAUGELINE_BROWSER_PATH to the browser's file.
```

That is what a run prints on stderr when `GAUGELINE_BROWSER_PATH` points at a file that is not there. If
Chromium refuses to start as the root user (inside many containers), Gaugeline says so and does not turn the
browser's own sandbox off: run it as an ordinary user.

## What the browser may not do

Loading a page runs the code of the site and of every third party it loads, so everything the browser asks for
goes through one gate in Gaugeline, never through the browser's own network. The browser's own network is
pointed at nothing, so a request that skipped the gate would fail instead of leaving.

| The page tries to...                                                   | What happens                                                                                                                                                                                                                                                                                                                 |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Send a POST, PUT, PATCH or DELETE, or a preflight, or submit a form    | Stopped and counted. Only `GET` and `HEAD` are ever sent                                                                                                                                                                                                                                                                     |
| Reach a private, loopback, link-local or metadata address              | Refused on the address the name resolves to, before a connection opens. `--allow-private` allows only the address you typed                                                                                                                                                                                                  |
| Redirect somewhere it should not go                                    | Each hop comes back through the gate and is checked again, so a redirect to a private address is refused                                                                                                                                                                                                                     |
| Redirect for ever                                                      | Stopped after 10 redirects                                                                                                                                                                                                                                                                                                   |
| Send a hit to an analytics, advertising or session replay tool         | Stopped and recorded if the host or path is on the built-in list, and never sent. The list is not complete: analytics a site runs from its own address under another name may still be requested (as `GET` or `HEAD`), so a rendered run can count as a visit. No setting turns the list off                                 |
| Open WebRTC or WebTransport                                            | In the page the names are removed, so a peer connection or a `WebTransport` fails at once. A dedicated worker can still see `WebTransport` (it exists there and fails: the browser's own network goes nowhere). WebRTC is also limited to UDP through that proxy. Tests listen on a UDP port and assert that nothing arrives |
| Open a WebSocket                                                       | Never connected, and counted                                                                                                                                                                                                                                                                                                 |
| Open a window or a dialog, start a download, register a service worker | The window is closed, the dialog dismissed, the rest refused                                                                                                                                                                                                                                                                 |
| Use a cookie, storage, a saved login or a permission                   | Every page gets a fresh browser context with none, and nothing is kept                                                                                                                                                                                                                                                       |
| Read Gaugeline's keys                                                  | The browser starts with a short list of harmless variables (`PATH`, `HOME`, `LANG` and similar), never a key                                                                                                                                                                                                                 |
| Use a `file:`, `javascript:` or other non-web address                  | Refused                                                                                                                                                                                                                                                                                                                      |

Gaugeline clicks nothing, types nothing and fills no form. What a page writes (its text, its links, its title)
is data from the site, never an instruction: it is cleaned and cut like every other page text
([text from the sites you check](./security/untrusted-content.md)).

If Gaugeline is stopped without a chance to clean up (a kill signal), the browser's temporary profile folder
(`playwright_chromiumdev_profile-` followed by letters, in your temporary folder) is left behind. It holds a
fresh profile and nothing of yours; delete it by hand.

A browser is not a wall. Chromium's own sandbox stays on, and the gate keeps the page from reaching anything you
did not type, but the browser is yours and so is what runs in it.

## What a render gives back

The renderer returns data and never a live page: the address the page ended on, how the server answered, the
text and links it was asked to expose, and every request the page made with what happened to it. This is the
invented bakery in `packages/fixtures/sites/renderer-edges`, which has an analytics tag and a script that writes
one line after the page loads:

```json title=Result
{
  "kind": "rendered",
  "finalUrl": "http://bakery.example/",
  "status": 200,
  "title": "Quillfeather Bakery",
  "text": "About Menu Partners Quillfeather Bakery An invented bakery: this line is in the page as sent. This line is written by a script after the page loads.",
  "links": [
    { "href": "http://bakery.example/about.html", "text": "About" },
    { "href": "http://bakery.example/menu.html", "text": "Menu" },
    { "href": "https://elsewhere.example/partners", "text": "Partners" }
  ],
  "requests": [
    {
      "url": "http://bakery.example/",
      "method": "GET",
      "kind": "document",
      "verdict": "allowed",
      "status": 200
    },
    {
      "url": "https://www.googletagmanager.com/gtag/js",
      "method": "GET",
      "kind": "script",
      "verdict": "blocked",
      "reason": "analytics"
    },
    {
      "url": "http://bakery.example/logo.svg",
      "method": "GET",
      "kind": "image",
      "verdict": "allowed",
      "status": 200
    }
  ],
  "blocked": {
    "method": 0,
    "scheme": 0,
    "address": 0,
    "analytics": 1,
    "websocket": 0,
    "popup": 0,
    "form": 0,
    "cap": 0,
    "failed": 0,
    "variant": 0
  },
  "totals": { "requests": 3 },
  "truncated": []
}
```

The second line of `text` was not in the HTML the server sent: a script wrote it. The `bytes` of each request
and of the total are left out here, and the query string of every address is never kept (it can carry a token).

## Clicking the plan's links

With a tracking plan (`gaugeline.events.json`), `--renderer playwright` also lets the click checks run. The
observer clicks each link the plan lists, once, at a desktop width and again at a phone width, and reads what the
page reported: pushes to `dataLayer` and the analytics requests the page tried to make, which are recorded and
never sent. Only links are clicked (never a button, an input or anything in a form), at most 20, and a link to
another site only when the plan names it by selector, with its navigation cancelled, and a navigation that would
leave the site (a redirect included) is refused. Every click gets a fresh browser context with the page loaded
again, so nothing one click stored reaches the next. A click that cannot be watched is could not check. The Tab key is
pressed (and nothing else is typed) to read the order the keyboard reaches the listed links in. The phone read and the
keyboard read are judged by `events-parity` and `events-tab-order`. What it reads and how the checks judge it:
[Click events](./guides/click-events.md#on-a-phone-and-with-the-keyboard).

## Accessibility facts

A check can also ask for the page's accessibility facts (`expose.a11y`): the colours the browser resolved for
text, the order Tab visits things in, the names it can give them, the landmarks, and whether animation has a
reduced-motion rule. The browser only reads them: nothing is focused, clicked or requested, and what comes back is
cut to a shape and a size before a check sees it. [Rendered accessibility](./guides/rendered-accessibility.md)
says what the five checks do with them.

## Loading with something taken away

A render can be asked for a **variant**: reduced motion forced (`prefers-reduced-motion: reduce`), JavaScript off,
or scripts from other sites refused. A variant only ever takes something away. A refused script is never
requested: the gate refuses it on the address the page names and on every address a redirect names (so a script
on the site's own address that redirects to a CDN is refused at the CDN), it counts towards the request cap, and
it is counted in `blocked` as `variant`. "Another site" means another registrable domain, so `cdn.site.co.uk` is
the site's own and `evil.co.uk` is not. JavaScript off makes the page do less, and every rule above holds as before. A render can also be asked to **measure** the load: Largest
Contentful Paint from the browser's DevTools timeline and the time long tasks spent over 50 ms (not measured with
JavaScript off, when no script runs). Both are what
[Speed attribution](./guides/speed-attribution.md) uses; neither is on unless a check asks.

## The caps

A page that goes past one of these is **could not check**, never a finding. The numbers are the decision
record's proposals: nothing measured them yet, so they may change.

| Cap                                                             | Limit                     |
| --------------------------------------------------------------- | ------------------------- |
| Time for one page                                               | 20 seconds                |
| Requests for one page                                           | 300                       |
| Bytes for one page                                              | 100 MB (20 MB a response) |
| Redirects in a row                                              | 10                        |
| Pages in one run                                                | 10                        |
| Time for the whole run                                          | 5 minutes                 |
| Text kept                                                       | 50,000 characters         |
| Links kept                                                      | 500                       |
| Calls a page makes to each function Gaugeline gives its scripts | 1,000                     |

A page can call the few functions Gaugeline gives its scripts (the one that counts a blocked form, the one that
passes on a click's pushes) as often as it likes, and each call costs the browser driver memory before any code of
ours runs: 100,000 calls held over a gigabyte. So each function has a budget of 1,000 calls per page. Past it the
page is closed and the load is **could not check** with the reason "the page called the functions Gaugeline gives
its scripts more times than a real page does". A real page makes a handful.

## For developers

The renderer is an interface in `@gaugeline/core` (`Renderer`: `availability`, `render`, `close`) and the rules
the browser is held to are core's egress gate, plain code with no browser in it, so a second renderer would
meet the same rules. The Playwright adapter is its own package, `@gaugeline/renderer`, inlined into the CLI
and loaded only by `--renderer playwright`. A check reads the rendered page through `ctx.render()`, which is
absent without the flag.

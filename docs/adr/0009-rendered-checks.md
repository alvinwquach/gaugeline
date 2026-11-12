# ADR-0009: Rendered checks: local Playwright by default, a microVM for the hosted tier, Firecrawl only when asked for

Status: proposed Date: 2026-11-12

**Waiting for the owner's decision; no browser is added.** This record proposes; it changes no code, no
flag and no line of CLAUDE.md. Nothing in X25's observer, N16 (accessibility and tools that compute) or
E-18's crawl source starts until the owner accepts one of the options below (or another). Branch
`08/adr-rendered-checks`, spec row G39. The spec asked for this record as number 0001; 0001 to 0008 are
taken, so it is 0009.

## Context

Gaugeline's promise today is that it reads the page and never runs it. ADR-0001 makes that true for the
network: every request to a checked site is a `GET` or a `HEAD` from the fetcher, and the fetcher refuses
private, loopback, link-local and metadata addresses. The checks parse the HTML text. A page's own
JavaScript never executes inside Gaugeline.

Rendering changes the promise from "never runs the page" to "runs the page in a sandbox". A browser
executes whatever script the site, and every third party the site loads, decides to send. That is a
decision about trust, cost and where the check runs, all at once, so it is written down before any of it is
built (spec G39).

### What needs a browser

| Check idea                                                    | Why the HTML text is not enough                                                            | Spec row                      |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------ | ----------------------------- |
| Layout at three widths: overflow, a fixed bar over the header | Layout is computed from CSS and fonts, not written in the HTML                             | none yet (named in G39)       |
| Client-only content: a price or menu filled in by a script    | The fetched HTML has an empty shell; the visitor sees the filled one                       | none yet (named in G39)       |
| WebGL and canvas fallbacks                                    | What a visitor sees when the graphics context is missing is only known by running the page | none yet (named in G39)       |
| Click events against the tracking plan                        | The `dataLayer` push happens after a click                                                 | X25 (merged, waiting for G39) |
| Accessibility basics (contrast, small text) and calculators   | Contrast and computed font size need computed styles; a calculator needs its script to run | N16 (waits for this record)   |

The layout widths are not in the spec; this record proposes 375, 768 and 1280 CSS pixels (phone, tablet,
laptop). Nothing else on the list is built. X25 already ships the seam: `EventObserver` in
`packages/core/src/events/observe.ts`, a recorded observer for tests, and checks that say could-not-check
while no observer exists.

### Why not on an edge function

The spec's roadmap row says it in one line: headless browsers do not run on edge functions, so rendering
is a separate service. What a browser needs is on Playwright's Docker page: a native multi-process
program, shared memory (`--ipc=host`, or Chromium "can run out of memory and crash"), and either the
Chromium sandbox with extra system calls allowed (a seccomp profile that permits user namespaces) or no
sandbox at all. An edge runtime gives a script no processes, no such system calls and no big binary. The
limits of Vercel's and Cloudflare's runtimes themselves (bundle size, memory, process spawning) could
not be read from this session: uncited. The consequence is the same either way: the hosted tier needs a
real machine, and a short-lived one, per run.

### What a run costs

No number below is measured; the spike at the end measures them. What the cost is made of:

- **Local Playwright:** the user's own time and memory, plus a one-time download of the browsers. Nothing
  is billed.
- **A sandbox service:** seconds of compute per page, times the provider's rate, times pages. Cost per
  thousand rendered pages = (median seconds per page x rate per second) x 1000, plus the start-up
  seconds of each sandbox spread over the pages it renders. The provider's rate is uncited (its pricing
  page could not be read).
- **Firecrawl:** billed per page on the user's own Firecrawl account (spec). Each scraped document
  reports `metadata.creditsUsed` in the SDK's types, and a crawl job reports a total `creditsUsed`
  [docs] 4. What a credit costs, and how many a page uses on each plan, is uncited.

### How a rendered result maps onto what exists

- **A Finding is unchanged.** The schema in `packages/core/src/result.ts` is strict: `checkId`,
  `severity`, `title`, `evidence`, `url`, optional `source`. A layout finding fits it: the evidence line
  is a measurement ("at 375 px the announcement bar covers 24 px of the header; selector `.bar`"), not a
  screenshot and not the client's text. An image is not a finding field; adding one is a result schema
  change and is not proposed here.
- **Rendered HTML enters the same snapshot path, as a second view, never a replacement.** The
  checks that say "21 words in the server-rendered HTML" want the unrendered page. So the run keeps the
  fetched `PageSnapshot` and builds a second one from the rendered DOM with the same extractor
  (`packages/core/src/snapshot.ts`), marked as rendered. A check says which view it reads. The difference
  between the two ("this heading exists only after the script runs") is the client-only-content check.
- **No renderer is the existing answer.** Without one, a rendered check reports could-not-check with a
  reason (as `NO_OBSERVER` does today), never a pass. The `sampled` map in the result gets a `rendered`
  entry (seen, taken, limit) like every other sampled kind.
- **Page text stays data.** Everything the browser returns (DOM text, console messages, titles, observed
  pushes) is page-derived and passes through N17's `UntrustedText` and `sanitise` before it reaches a
  finding, a report, a notification or an agent. N17 (`06/injection-safety`) had not merged when this was
  written; the first rendered branch must not merge before it does.

### The isolation problem

A rendered check loads an address an outsider controls and runs the code it sends. What can go wrong, and
what the design has to stop:

1. **A browser flaw lets the page reach the machine.** Playwright's own documentation says its Docker
   image "is intended to be used for testing and development purposes only. It is not recommended to use
   this Docker image to visit untrusted websites", and that for crawling untrusted sites to run the
   browser as a separate user with the seccomp profile, because as root the Chromium sandbox is turned off [docs] 1. In the library itself `chromiumSandbox` "Defaults to `false`" [docs] 2. A
   container is therefore a convenience, not the wall. The wall for the hosted tier is a microVM; Vercel
   Sandbox describes itself as "isolated Linux microVMs", each "a Firecracker MicroVM" [docs] 3.
2. **The page's own scripts write.** A page can `POST` an analytics beacon, submit a form on load, open a
   WebSocket, register a service worker, trigger a download or navigate away. None of these go through
   the fetcher, so ADR-0001's rule does not hold by itself inside a browser.
3. **The page reaches addresses the public cannot.** On a developer laptop or a CI runner a page's script
   can request `127.0.0.1`, a router or a cloud metadata address. The fetcher's address refusal does
   not apply to a browser that resolves names itself. A request handler sees the address the page named,
   not the address it resolved to, so a hostname that resolves to a private address (DNS rebinding)
   passes a handler that checks names only.
4. **Keys.** The engine process holds `SANITY_TOKEN`, `FIRECRAWL_API_KEY` and others. Nothing in the
   browser's process or machine may be able to read them.
5. **A page that never ends.** Infinite loops, memory growth, a 2 GB download, ten thousand requests.
6. **Interaction as a side effect.** Rule 14 says Gaugeline "looks; it never pokes". A click or a typed
   value on a live site can fire a request, even a `GET` that changes something. Clicking is new: no
   current check does it.

## Decision

Proposed, for the owner to accept, change or refuse. **Local Playwright is the default renderer. A
sandboxed microVM is the renderer of the hosted tier. Firecrawl is an opt-in renderer. Rendering is never on
unless the run names a renderer.**

### 1. One seam, no browser in core

The observer interface that X25 started becomes the renderer interface: it takes an address, the widths
and the interactions the run is configured to make, and returns data (the rendered HTML, layout
measurements, observed pushes, the requests it blocked), never a live page. `packages/core` imports no
browser and still never calls `process.exit` (CLAUDE.md rule 8). A renderer lives in its own package,
loaded only when a run asks for it; if it is not installed the rendered checks are could-not-check with
the install hint. The browser is installed by an explicit command the user runs, never downloaded in the
middle of a run (ADR-0003: a run contacts no host the user did not name). The CLI bundle gets no new
runtime dependency (the Dependencies row of the spec's updates). This record does not decide package
names.

### 2. The three renderers, behind that seam

|                                     | 1. Local Playwright (default)  | 2. Sandboxed microVM (hosted tier)           | 3. Firecrawl (opt-in)                                                                                  |
| ----------------------------------- | ------------------------------ | -------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Flag                                | `--renderer playwright`        | chosen by the hosted service, not by a flag  | `--renderer firecrawl`                                                                                 |
| Where the page runs                 | The user's machine or their CI | A throwaway microVM per run, destroyed after | Firecrawl's servers                                                                                    |
| Who sees the page                   | Nobody else                    | Gaugeline's hosted service                   | Firecrawl, a third party                                                                               |
| Browser version                     | Pinned by Gaugeline            | Pinned by Gaugeline                          | Not pinned by Gaugeline                                                                                |
| Layout at three widths, clicks, axe | Yes                            | Yes                                          | No: the scrape API returns a page, and its `actions` (click, write, execute JavaScript) are never sent |
| Billing                             | None                           | Compute seconds on Gaugeline's account       | Per page, on the user's Firecrawl account                                                              |
| Credentials in it                   | The browser gets none          | None mounted                                 | The user's key is sent to Firecrawl only                                                               |
| Same input, same findings           | Yes, within the pinned version | Yes                                          | Not guaranteed                                                                                         |

Firecrawl is limited to what a scrape can honestly give: client-only content, a rendered link and
image list, and E-18's URL list. It cannot do the three-width layout checks or click events, so those say
could-not-check under it.

### 3. The browser is read-only: the egress gate

Every renderer that runs a browser on Gaugeline's side (1 and 2) puts all of the browser's traffic
behind one gate, written once:

- **Method.** Only `GET` and `HEAD` leave. Anything else is aborted and recorded (the request's method
  and host, never its body). A check that needs a write to produce its answer (a calculator that sends the
  sum to a server) reports could-not-check with the blocked request as evidence. This is the rule N16 already
  states: "block all non-GET requests from the page during the check".
- **Address.** The browser is pointed at a proxy that Gaugeline runs, which resolves each name and refuses
  private, loopback, link-local and metadata addresses with the transport's own rule
  (`packages/core/src/transport.ts`) at connect time, so a rebinding name is refused for the address it
  resolved to. A request handler in the browser (Playwright's `route`) is a second screen for method and
  scheme, not the address rule. `--allow-private` carries over, for a local site the user is building.
  In the hosted tier the microVM's own network policy must also deny private ranges; if a sandbox
  provider cannot restrict egress, it fails this record's requirement (what the provider offers is
  uncited).
- **Browser settings.** A fresh context per page with no cookies, storage or profile (Playwright: a new
  context "won't share cookies/cache with other browser contexts" [docs] 2); service workers blocked
  (`serviceWorkers: "block"`, so no worker can answer a request behind the gate); downloads not accepted;
  no permissions granted; dialogs dismissed; popups closed; the Chromium sandbox turned on explicitly
  (`chromiumSandbox: true`), and the browser run as an ordinary user, not root.
- **Caps** (proposed, the spike sets the final numbers): 20 seconds and 300 requests per page, 100 MB
  transferred per page, 1 GiB of memory for the browser, 5 minutes per run. A cap that trips is
  could-not-check for that page, never a finding.
- **No keys.** The browser is launched with an environment that holds nothing from the engine's
  (Playwright's launch options take an `env`), and in a microVM nothing is mounted: the engine hands in an
  address and gets data back. The spike plants a canary value in the engine's environment and fails if
  it appears anywhere a page could reach.

### 4. Interaction needs a list the site's owner wrote

Loading and measuring a page is looking. Clicking, typing and submitting are the first things Gaugeline
would do to a page, and rule 14 says it never pokes. This record proposes that no interaction happens
without a config file that names the targets (X25's tracking plan, N16's `tools`), that only those
elements are touched, that all of it happens behind the egress gate (so no click can write), and that a
click on an element inside a form that would submit is refused. Whether rule 14 needs a sentence about
this is a decision for the owner (see "Decisions for the owner").

### 5. Firecrawl, if the owner allows it

The rules below hold in addition to the gate's spirit (Firecrawl runs the browser, so Gaugeline cannot
gate it; it can only limit what it asks for and what it believes).

- **Opt-in, own key.** `--renderer firecrawl` and `FIRECRAWL_API_KEY` from the environment. The key goes
  in the `Authorization` header and never in an address, a log, a finding, a saved request file or a
  report (rule 6). With no key the run stops before any request with a message that names the variable.
- **Every request sets** `maxAge: 0` (never a cached copy), `onlyMainContent: false` (checks read the nav
  and the footer), and, proposed beyond the spec, `storeInCache: false` so the page is not kept for the
  next customer. The response's `metadata.cacheState` must not say `hit`; one that does is
  could-not-check, not a finding [docs] 4.
- **Never sent:** `actions`, `headers`, `profile`, `webhook`, `proxy`, `skipTlsVerification`,
  `ignoreRobotsTxt`, `checkPromptInjection`, `redactPII`, or any option whose purpose is to act as the
  visitor, to carry a credential, to deliver the result somewhere else or to cost extra [docs] 4. The
  request body is built from a fixed list of keys (the shape ADR-0006's `json-query` already uses), and
  a test asserts the list.
- **The address is checked first.** Firecrawl fetches from its own servers, so Gaugeline's address
  rule would otherwise be skipped. Before any request the typed address and every redirect hop Gaugeline
  already knows pass the fetcher's private-address refusal; `--renderer firecrawl` with `--allow-private`
  is refused (a local site is unreachable from Firecrawl, and a private address must never be sent to a
  third party).
- **Page text is data.** The response's HTML enters the snapshot path as the rendered view. Fields the
  service adds beside the page (`agent_hints`, a `warning`) are data as well, never instructions
  (rule 11, N17) [docs] 4.
- **The user is told before and after.** The run header states the page count and the cap ("Rendering 6
  pages through Firecrawl, billed to your account; cap 10"), the end of the run states the credits the
  responses reported, and `--max-rendered-pages` applies to every renderer, default 10 (proposed). Past
  the cap the rest are could-not-check.
- **The address goes to a third party.** The user named the host by choosing the renderer (ADR-0003), and
  the Privacy and Security pages must say that the checked address, and the page content, pass through
  Firecrawl. The user's own site may be one they would not want to. That is why it is opt-in.
- **AGPL.** Firecrawl's repository is licensed AGPL-3.0, and its SDKs and some components MIT [docs] 5.
  Gaugeline only calls the hosted API over HTTPS and never bundles, copies or self-hosts its code. If the
  SDK is wanted later it is a dependency decision on its own (it is MIT); this record proposes none: the
  request bodies are small and built from the fixed list above.
- **The method is a `POST`.** Firecrawl's scrape and crawl are `POST` endpoints (`/v2/scrape`,
  `/v2/crawl`) [docs] 4. ADR-0006 allows a `POST` that "carries a question, not a change", from an
  adapter's allowlist, to a platform's own API, and says a `POST` "is not a way to test a checked page".
  A scrape names the checked page in its body and makes someone else's browser load it, and it spends
  the user's money, so ADR-0006 does not cover it as written. This is the first of the owner's decisions
  below.

### 6. Firecrawl as a URL source for E-18

E-18 (migration completeness) needs the old site's page list. Firecrawl can supply it behind the same
key: `POST /v2/crawl` starts a job, a `GET` of the job returns its pages with a total `creditsUsed`, and a
`DELETE` cancels it; `POST /v2/map` returns a site's URLs in one call and starts no job [docs] 4. The
spec asks to record the crawl endpoint; this record also records `map`, which costs fewer pages if it
returns enough (its price is uncited), so E-18 tries `map` first and a crawl only if it must. The same
rules apply: opt-in, own key, `--max-rendered-pages` as the cap on crawled pages (`limit`), never
`ignoreRobotsTxt`, never a `webhook`, the old address passed through the private-address refusal first,
and the list is data. E-18's own order stays first: the WordPress REST API, the sitemap, the home page's
links, a local export. Firecrawl is the last resort, because it is the only source that sends the old
address to a third party.

### Decisions for the owner

1. **POST to Firecrawl.** Either amend ADR-0006 (a renderer entry on a per-endpoint allowlist: host
   `api.firecrawl.dev`, the paths above, the fixed key list, the cap, and a statement that this `POST`
   is the user's own account asking a service to read a public page), or do not ship Firecrawl. This
   record recommends the amendment, as its own branch with its own contract test, and nothing of
   Firecrawl is built until it has merged.
2. **Rule 6 wording.** A browser's subresource requests do not go through the fetcher. If this record is
   accepted, CLAUDE.md rule 6 needs a sentence: a renderer's browser may request only through the egress
   gate, `GET` and `HEAD` only, with the fetcher's address refusal. Not edited here.
3. **Rule 14 and interaction.** Whether clicking and filling named targets needs the same
   "run only on sites you own or have permission to test" wording as a probing check. This record
   proposes the config-file rule in part 4 and no consent flag, because nothing is sent to the site that
   the visitor would not send; the owner may prefer to require consent.
4. **The cost ceiling.** The spike's cost line has a number the owner sets (proposed: no more than US$2
   per thousand rendered pages for the hosted tier). It is a placeholder.

## Alternatives

- **Do nothing: keep rendered checks as could-not-check.** The honest alternative. Lost for now because
  X25 and N16 name real client pain (an announcement bar that fails contrast, a calculator that rounds
  wrong, clicks that report nothing) that the HTML text cannot show. It stays right if the spike fails
  its safety measures: a wrong answer here is a client's site being blamed, or a user's machine being
  reached.
- **A DOM emulator (jsdom or happy-dom) instead of a browser.** Cheap, runs anywhere, even on an edge
  function. Lost because it computes no layout, no contrast and no real fonts, so the headline checks
  cannot be done, and it still runs the page's scripts in Gaugeline's own process, with Gaugeline's
  keys beside them. Whether either emulator can compute layout was not checked: uncited.
- **The hosted sandbox as the only renderer.** Lost as the default because a user running Gaugeline on
  their own machine would send their site's address and content to a Gaugeline service for a thing their
  own machine can do (ADR-0003's spirit), and every run would cost money. It stays the right shape for
  the hosted tier, where there is no "own machine".
- **Firecrawl as the default.** Lost because the page runs on a third party's machine, billing is per
  page on the user's account, the browser version is not Gaugeline's to pin (so rule 7's "same input,
  same findings" weakens), the layout and click checks are out of its reach, and the address and the
  content leave the user's machine. Kept as an opt-in because it solves the case Playwright cannot: a
  user with no installable browser (a locked CI image, a Windows machine with no admin rights) who wants
  a client-only-content check and is happy to pay a few credits.
- **Another managed browser service (Browserbase, Browserless, Cloudflare's browser service).** Not
  evaluated in detail: their documentation was out of reach, so each is uncited. Each shares Firecrawl's
  drawbacks (third party, billing, unpinned browser) without Firecrawl's scrape-and-crawl shape. They
  would sit behind the same seam if the owner asks for one.
- **The Playwright Docker image as the isolation boundary.** Lost because Playwright's own page says the
  image should not visit untrusted websites; the image runs as root by default, which turns the Chromium
  sandbox off [docs] 1. The image is fine as the base of the microVM's filesystem, with a non-root user and the seccomp
  profile it ships, but the microVM is the wall.
- **Checking the request address in the browser only (a `route` handler).** Lost because the handler sees
  the name, not the address resolved for it; a hostile name resolves to a private address after the check.
  The proxy resolves and refuses at connect time.
- **Let the browser send writes and compare afterwards.** Lost: it is rule 14's "never pokes" in its
  plainest form.

## Cost

- A new moving part of real size: a browser, a proxy, a package, a CI job, a per-OS download. Each is
  maintained for as long as the checks exist, and browsers need security updates often (how often: uncited).
- The promise on the Security and Reference pages changes from "never runs the page" to "runs the page
  in a sandbox, when you ask it to". Pages that say the first have to be changed in the same pull
  request that ships the first renderer.
- Rendered runs are slower than fetched ones, by seconds per page rather than milliseconds, and heavier in
  memory. That is why rendering is off unless asked for, and capped.
- The hosted tier pays for compute on every rendered run, and its cost per thousand pages decides its
  pricing.
- Findings from a rendered check depend on the browser version, fonts and viewport. The browser is
  pinned, and the same input gives the same findings within a pinned version; an upgrade can change
  findings, so it ships with a changeset.
- Firecrawl: a third party holds the address and the page; the user pays per page; a Firecrawl outage or
  a site that blocks Firecrawl's address ranges turns the check into could-not-check; the browser it runs
  is not ours to pin or to read. The AGPL line means Gaugeline can never offer a self-hosted Firecrawl
  inside the product.
- A proxy of Gaugeline's own sits between the browser and the network, which is code that has to be right
  about address resolution, redirects and HTTP framing. It is the one component that carries the safety
  claim, so it gets the hostile suite below.

## What would change it

- The spike (below) fails a safety measure: then no renderer ships and the checks stay could-not-check
  until a design passes.
- The spike fails the speed or memory measures for local Playwright: then the hosted tier is the only
  renderer and the local one is dropped.
- A sandbox provider cannot restrict egress or cannot be destroyed per run: that provider is out.
- Firecrawl documents a read-only, no-cost-surprise mode, or changes its pricing, retention or `POST`
  semantics, or its license: reopen part 5.
- Evidence that few users want rendered checks (nobody asks for X25's events or N16): drop the whole
  plan. The roadmap already says "built when someone asks" for the neighbouring rows.
- Evidence that a site owner reads "never runs the page" as the thing they trust Gaugeline for: the
  promise is worth more than the checks, and the decision should be reopened with that in front of it.

## Spike plan: one day, pass or fail

Goal: show, with measurements, that rendering is safe, fast enough and affordable, or show that it is
not. Nothing from the spike is merged; the output is a table filled in under this section by the pull
request that accepts or refuses the decision. Fixtures are invented: bars, a pop-up, a clinic, a coach's
calculator, all with made-up names, served from the fixture server on 127.0.0.1 (a test never uses the
name "localhost").

| Hours  | Work                                                                                                                                                                                              |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0 to 1 | Pin `playwright-core` and Chromium. Render five invented pages at 375, 768 and 1280: a bar that covers the header on a phone, a menu filled by script, a canvas hero, a calculator, a plain page. |
| 1 to 3 | Build the egress gate: the proxy that refuses private addresses at connect time, the `route` screen for method, the context settings and caps from part 3.                                        |
| 3 to 5 | Measure: 50 runs of the five pages, three widths each, browser warm and cold; record wall seconds and peak resident memory of the browser tree.                                                   |
| 5 to 6 | The hostile page set (below), run through the gate on the laptop and again inside a microVM from a sandbox account the owner provides.                                                            |
| 6 to 7 | Firecrawl, if the owner provides a key: scrape one throwaway page the owner publishes on their own domain and crawl its two-page sitemap, and inspect every request body.                         |
| 7 to 8 | Fill in the table, compute cost per thousand pages from the measured seconds and the sandbox's published rate, write the result into this record.                                                 |

**Needs from the owner** before the day: a sandbox account and its published rates, and a Firecrawl key
with a small credit balance (the spike uses at most 10 pages). The spike creates no account and uses no
live key of anyone else's. Without those, the matching rows stay "blocked: needs owner", not "passed".

**The hostile page set** (invented pages that try, on load or on a configured click): a `POST` beacon, a
form that submits itself, `fetch` to `127.0.0.1`, to a link-local metadata address and to a name that
resolves to a private address after the first lookup, a WebSocket, a service worker, a download, an
infinite loop, an allocation of a gigabyte, ten thousand requests, a 2 GB response, a click target that
is a submit button, and a title that says "ignore previous instructions".

**Pass measures** (every one must hold for the decision to stand):

| #   | Measure                        | Pass if                                                                                                                                                |
| --- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| S1  | Writes that reach the wire     | Zero requests with a method other than `GET` or `HEAD` arrive at the fixture server, in all hostile pages                                              |
| S2  | Private addresses              | Zero requests reach a listener on a loopback, link-local or private canary address, including the rebinding name                                       |
| S3  | Keys                           | A canary value planted in the engine's environment is not found in the browser's environment, the microVM's files, any request, any finding or any log |
| S4  | Caps                           | Each runaway page (loop, memory, size, request count) ends within its cap plus 2 seconds, and is could-not-check, not a finding                        |
| S5  | Determinism                    | The same fixture rendered 20 times gives byte-identical findings in 20 of 20                                                                           |
| S6  | Text is data                   | The hostile title appears in a finding only as sanitised evidence, never as a title or a rule                                                          |
| P1  | Seconds per page (local, warm) | Median at most 8 s for three widths and axe together; 95th percentile at most 20 s                                                                     |
| P2  | Memory (local)                 | Peak resident memory of the browser tree at most 1 GiB                                                                                                 |
| P3  | Cold start                     | Browser launch to first render at most 5 s                                                                                                             |
| P4  | Cost (hosted)                  | Cost per thousand pages at or under the owner's ceiling (placeholder US$2)                                                                             |
| F1  | Firecrawl request body         | Every captured body has `maxAge` 0, `onlyMainContent` false, `storeInCache` false and none of the never-sent keys                                      |
| F2  | Firecrawl cache                | No response says `cacheState` is `hit`                                                                                                                 |
| F3  | Firecrawl billing              | The credits the responses report match the pages the header stated, and the header's cap stops the run                                                 |

**Fail rules.** Any S measure failing stops the plan (no renderer ships). P1 or P2 failing drops local
Playwright as the default and leaves the hosted tier. P4 failing leaves the hosted tier unpriced and the
decision open. F1 to F3 failing drops Firecrawl and E-18's use of it, and touches nothing else.

## Enforced by

Nothing new, because nothing is built. What already holds, and what a built version would sit on:

- `packages/core/src/fetcher.ts` and `packages/core/src/__tests__/fetcher.test.ts` (every request to a
  checked site is a `GET` or a `HEAD`; private, loopback, link-local and metadata addresses are refused)
- `packages/core/src/transport.ts` (the address rule the proxy reuses, applied at connect time)
- `packages/core/src/events/observe.ts` (the observer seam, the recorded observer, and
  could-not-check while no observer exists)
- `packages/core/src/fetch/query-registry.ts`, `packages/core/src/__tests__/post-boundary.test.ts` and
  `packages/core/src/__tests__/post-scan.ts` (the only place a `POST` to a vendor's API may be registered;
  where Firecrawl's would go if the owner amends ADR-0006)
- `packages/cli/src/__tests__/no-phone-home.test.ts` (a run contacts only the checked site and
  configured destinations; a renderer must keep this true)
- `eslint.config.js` (`no-restricted-imports`, which keeps connections in one file; a rule keeping any
  browser import out of `packages/core` would join it)

Tests the first rendered branch must write first: the hostile page set above as a fixture site; the
egress gate unit tests (method, scheme, a name that resolves to a private address after the first
lookup, redirects into a private address); a scan that fails any file that imports a browser library
from `packages/core`; the context settings asserted from the options actually passed; the canary-key test;
the cap tests; and, for Firecrawl, a contract test on the request body (the fixed key list, `maxAge`
0, `onlyMainContent` false, `storeInCache` false), a test that the key never appears in a log, a finding
or the saved requests file, and a test that a response saying `cacheState: "hit"` is could-not-check.

## Sources

Vendor sites (playwright.dev, vercel.com, docs.firecrawl.dev, adr.github.io) answered 403 from the
build session's proxy. Each [docs] line below is therefore from the vendor's own repository or package,
read directly, which is what the vendor's page is built from. A claim with no text behind it is
marked uncited.

1. Playwright, "Docker", `docs/src/docker.md` in `microsoft/playwright` (the source of
   playwright.dev/docs/docker): "This Docker image is intended to be used for testing and development
   purposes only. It is not recommended to use this Docker image to visit untrusted websites."; "By
   default, the Docker image will use the `root` user to run the browsers. This will disable the
   Chromium sandbox which is not available with root."; "On untrusted websites, it's recommended to use a
   separate user for launching the browsers in combination with the seccomp profile."; `--ipc=host`
   recommended, "Without it, Chromium can run out of memory and crash". [docs]
2. `playwright-core` 1.63.0 type definitions (installed in this repository):
   `chromiumSandbox?: boolean` "Enable Chromium sandboxing. Defaults to `false`."; `serviceWorkers?:
"allow"|"block"`; `acceptDownloads`; `proxy: { server }` ("Proxy to be used for all requests");
   `env` among launch options; `route(url, handler)`; `Route.abort`; `newContext` "It won't share
   cookies/cache with other browser contexts." Also: "Enabling routing disables http cache." [docs]
3. Vercel Sandbox README (`vercel/sandbox`): "run arbitrary code in isolated Linux microVMs";
   "Internally, it is a Firecracker MicroVM"; `@vercel/sandbox` 3.9.1 on npm (Apache-2.0). Its network
   policy, limits, per-second rates and whether it can be destroyed per run: uncited (the page was out of
   reach). [docs] for the first two statements only.
4. Firecrawl Node SDK, `@mendable/firecrawl-js` 4.52.0 on npm (MIT), types and sources: `POST /v2/scrape`,
   `/v2/crawl` (with a `GET` status and a `DELETE`), `/v2/map`; `ScrapeOptions` including
   `onlyMainContent`, `maxAge` ("Set to `0` to bypass index reuse"), `storeInCache`, `actions`,
   `headers`, `profile`, `proxy`, `skipTlsVerification`, `checkPromptInjection`; `CrawlOptions`
   including `limit`, `webhook`, `ignoreRobotsTxt`; `DocumentMetadata.cacheState` ("hit" or "miss"),
   `creditsUsed`, `statusCode`; `agent_hints` ("API guidance, separate from extracted page content").
   Credits per page, price per credit, data retention, rate limits, what `map` costs, and whether
   `zeroDataRetention` is open to every plan: uncited. [docs]
5. Firecrawl README and LICENSE (`firecrawl/firecrawl`): "Firecrawl is open source under the AGPL-3.0
   license"; "The SDKs and some UI components are licensed under the MIT License." [docs]
6. Spec G39 (prompt, tests, architecture notes); the Roadmap row "Rendered checks in a container: Later,
   P5: Headless browsers do not run on edge functions. A separate service."; "Updates since the build
   started", Rendered pages: "built against an observer interface, tested on recorded observations, and
   reports could-not-check until G39 decides on rendering"; N16 ("block all non-GET requests from the
   page during the check"; "Rendering changes Gaugeline's promise from 'never runs the page' to 'runs
   the page in a sandbox'"); N17 (page text as data); E-18 (the old site's content list); PROGRESS.md,
   the G39 row ("Spec update 10 Nov"). [repository]
7. This repository: ADR-0001, ADR-0003, ADR-0004, ADR-0006, ADR-0008, CLAUDE.md rules 6, 7, 8, 11, 13
   and 14, `packages/core/src/events/observe.ts`, `packages/core/src/result.ts`,
   `docs/guides/click-events.md`. [repository]
8. Decision-record structure: Michael Nygard's template, listed at the ADR GitHub organisation's
   collection (`joelparkerhenderson/architecture-decision-record`, README); this repository's own
   template is `docs/adr/0000-template.md`. [docs]
9. Uncited, stated as proposals: the three widths (375, 768, 1280), the caps (20 s, 300 requests, 100 MB,
   1 GiB, 5 minutes, 10 pages), the pass thresholds, the placeholder cost ceiling, `storeInCache: false`,
   and the use of a connect-time proxy. They are this record's own choices, for the spike to confirm or
   change. Edge-runtime limits and the other managed browser services are also uncited.

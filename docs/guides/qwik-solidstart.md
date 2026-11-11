# Qwik and SolidStart sites

A bike-repair shop, a coffee cart or a barber booking page built on Qwik City or SolidStart sends the
browser more than the page. The serialized state travels with the HTML, there is a data address
behind every Qwik City route, server functions sit at addresses anyone can call, and a preview build
can leak into the live site. These checks look at that, using only what the site already serves to
every visitor, plus one switch for the part that asks a route a visitor would not normally ask.

## How a Qwik or SolidStart site is recognised

From the markup the server writes. Qwik: a `q:container` attribute on the root element, a
`<script type="qwik/json">` state, or modules named `/build/q-<hash>.js`. SolidStart: the `_$HY`
hydration bootstrap together with `/_build/` assets or `window.manifest`, or a form that posts to
`/_server?id=...`. On any other site the checks below are not run.

## The checks

- `qwik-solid-draft-public` (fix first, **probing**): a conventional preview route (`/api/preview`,
  `/api/draft`, `/preview`, `/draft`) sets a cookie whose name contains `preview` or `draft` for a
  request that carried no secret. Each route is asked once with a plain `GET`; no secret is sent or
  guessed. It runs only with `--owner-consent` (or a `gaugeline.consent.json`): **run only on sites
  you own or have permission to test**. Without consent it asks nothing and says so under "could
  not run".
- `qwik-solid-preview-canonical` (fix first): the canonical address, `og:url`, `og:image` or a
  sitemap entry of a production page is on a preview domain (`vercel.app`, `netlify.app`,
  `pages.dev`).
- `qwik-solid-data-as-page` (fix first): a page address answers with Qwik City route data (a
  `q-data.json` payload, `{"_entry":"..","_objs":[...]}`), or the sitemap lists `q-data.json` or
  `/_server` addresses. No extra request is made.
- `qwik-solid-vary-missing` (fix first): the same address returns HTML to a browser and JSON to
  `Accept: application/json`, and neither answer lists `Accept` in `Vary`. Neither framework does
  this for a successful page by itself, so it catches an endpoint or middleware you added. One extra
  `GET`, with the `Accept` header only.
- `qwik-solid-private-fields` (fix first): the state embedded in the page (Qwik's `qwik/json` script,
  SolidStart's `_$HY` data), or a Qwik page's own `q-data.json`, has fields named like something
  private (`password`, `token`, `secret`, `apiKey`, `internalNotes` and a few more, matched by word).
  **Names only, never values.**
- `qwik-solid-dev-server-live` (fix first): the page was served by the Vite dev server (a Qwik
  container rendered in `ssr-dev` mode or with a `dev` manifest hash, or a page that loads
  `/@vite/client`, `/@qwik-city-plan` or `/_build/@fs/`). Read from the page already fetched.
- `qwik-solid-server-endpoints` (worth knowing): the page names a server-function address, Qwik's
  `?qfunc=` (`server$`) or `?qaction=` (`routeAction$`), or SolidStart's `/_server` (`"use server"`).
  It is a heads-up, not a verdict: Gaugeline **never calls** these addresses, so it cannot say
  whether a function checks who is asking. Read each one once.

`q-data.json` of the page being checked is the same address Qwik City's own client asks for when a
visitor navigates to that page, so it is not a probing request. Gaugeline does not ask for the
`q-data.json` of pages the checked page does not link to, does not call `/_server`, `?qfunc=` or
`?qaction=`, and does not ask for dev-only paths such as `/@vite/client` or `/__inspect` itself.

When a state or payload cannot be read (not JSON, larger than the cap, cut, an error, or another
Qwik version's format), the check says it could not check, with the reason; it does not pass the page.

## Example

Against the invented `qwik-like` fixture, a bike-repair shop on Qwik City copied from a preview
build, run with `--owner-consent` because the owner agreed to it, version 0.1.0 prints:

```text title=Output
✗ This page tells Google to show a different page
    <link rel="canonical" href="https://spokeandchain-git-main-team.vercel.app/"> on http://spokeandchain.test/ (differs by scheme, host)
✗ A page address returns Qwik City data, not a page
    the sitemap lists 1 data address
✗ Anyone can switch on preview mode
    /api/preview set preview_session with no secret
✗ The live Qwik or SolidStart site points search engines at a preview deployment
    canonical https://spokeandchain-git-main-team.vercel.app/ is on a preview domain
✗ The data sent with a page has fields that look private
    the embedded state has apiToken; /q-data.json has apiToken (field names only)
✗ One address serves a page and JSON, and caches aren't told
    The address returns HTML to a browser and JSON to Accept: application/json, and neither response lists Accept in Vary: a shared cache can hand the JSON to a visitor
· This page calls server functions that anyone can address
    the page names ?qfunc= or ?qaction= 1 time (not called)
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

7 to look at, 6 to fix first.
```

`canonical-elsewhere` reports the same canonical from the search side. Each check that passed also
prints a `✓ <id>` line, left out above. The output is asserted by
`packages/cli/src/__tests__/qwik-solid.test.ts`.

## What was looked up

The docs sites (`qwik.dev`, `docs.solidjs.com`) were not reachable from the build machine and no live
site was looked at, so every address and marker is read from the packages' own source on 11 November
2026 (cited as [docs: package source]): `@builder.io/qwik` 1.20.4, `@builder.io/qwik-city` 1.20.4,
`solid-js` 1.9.19 and `@solidjs/start` 1.5.1 from npm. The fixtures are invented and reproduce the
structure that source writes.

- Qwik container attributes (`q:container`, `q:render` `ssr` or `ssr-dev`, `q:manifest-hash`
  `dev<hash>` without a build) and `<script type="qwik/json">` with `refs`, `ctx`, `objs`, `subs`
  and `<` written as `\x3C`: `@builder.io/qwik` `server.mjs` and `core.mjs`.
- `<route>/q-data.json` as `{"_entry","_objs"}` (loaders, action, status, href), `?qfunc=` for a
  `server$` call and `?qaction=` for a `routeAction$`: `@builder.io/qwik-city` request handler
  (`renderQData`, `makeQDataPath`, `runServerFunction`) and `index.qwik.mjs`.
- `_$HY`, the writes to `_$HY.r` and `data-hk`: `solid-js/web` `server.js`. `/_build/assets/`,
  `window.manifest`, `/_build/@fs/` and `/_server?id=...&name=...`: `@solidjs/start` `config`,
  `StartServer.jsx`, `runtime/server-runtime.js`.

Uncited, and said so in each check's technical line: the preview route names and the preview or
draft cookie rule (neither framework has a built-in draft mode; these are conventions of CMS
starters), the words that mark a field name as private, the `Accept` negotiation test, Qwik 2's
state format (`@qwik.dev/*`, not read: reported as could not check), and whether real Qwik pages
name `?qfunc=` or `?qaction=` in their markup as the fixture does.

## Not checked

Server functions are named, never called. Dev-only paths and the `q-data.json` of pages nobody links
to are not requested. Discovery still follows `/build/` and `q-data.json` links as it would any link.

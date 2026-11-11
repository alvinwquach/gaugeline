# SvelteKit sites

A climbing gym, a coffee roaster or a physio clinic built on SvelteKit sends the browser more than
the page. Every `load` function's result travels with the page, there is a data address behind
every route, and a preview build can leak into the live site. These checks look at that, using only
what the site already serves to every visitor, plus one switch for the part that asks a route a
visitor would not normally ask.

## How a SvelteKit site is recognised

From its responses: the `x-sveltekit-page: true` header, or, behind a proxy that strips it, the
inline `__sveltekit_<hash>` bootstrap script, `data-sveltekit-*` attributes on the markup, or
modules under `/_app/immutable/`. On any other site the checks below are not run.

## The checks

- `sveltekit-draft-public` (fix first, **probing**): a conventional preview route (`/api/preview`,
  `/api/draft`, `/preview`, `/draft`) sets a cookie whose name contains `preview` or `draft` for a
  request that carried no secret. Each route is asked once with a plain `GET`; no secret is sent or
  guessed. It runs only with `--owner-consent` (or a `gaugeline.consent.json`): **run only on sites
  you own or have permission to test**. Without consent it asks nothing and says so under "could
  not run".
- `sveltekit-preview-canonical` (fix first): the canonical address, `og:url`, `og:image` or a
  sitemap entry of a production page is on a preview domain (`vercel.app`, `netlify.app`,
  `pages.dev`).
- `sveltekit-data-as-page` (fix first): a page address answers with route data
  (`application/json` or `text/sveltekit-data` holding `{"type":"data","nodes":...}`), or the
  sitemap lists `__data.json` addresses. No extra request is made.
- `sveltekit-vary-missing` (fix first): the same address returns HTML to a browser and JSON to
  `Accept: application/json` (a `+page` and a `+server` in one route), and neither answer lists
  `Accept` in `Vary`. SvelteKit adds that header itself, so a missing one usually means a CDN
  stripped it. One extra `GET`, with the `Accept` header only.
- `sveltekit-private-fields` (fix first): the data embedded in the page, or the page's own
  `__data.json`, has fields named like something private (`password`, `token`, `secret`, `apiKey`,
  `internalNotes` and a few more, matched by word). **Names only, never values.**
- `sveltekit-dev-server-live` (fix first): the page was served by `vite dev` (its global is
  `__sveltekit_dev`, or it loads `/@vite/client`, `/.svelte-kit/` or `/node_modules/.vite/`). Read
  from the page already fetched.
- `sveltekit-stale-page` (fix soon): the build version written into the page differs from the one in
  `/_app/version.json`, so the page is a copy from an earlier deploy (a CDN holding a prerendered
  page, for example). The version file is public and every visitor's browser asks for it.
- `sveltekit-data-unshown` (worth knowing): text fields in the page's `__data.json` that are not on
  the page. Names only. A field a script uses, or another page reads, is listed too, so read it as a
  prompt, not a verdict.

`__data.json` of the page being checked is the same address SvelteKit's own client asks for when a
visitor navigates to that page, so it is not a probing request. Gaugeline does not ask for the
`__data.json` of pages the checked page does not link to, and does not ask for dev-only paths such
as `/__inspect` or `/@vite/client` itself.

When the payload cannot be read (an answer that is not SvelteKit's data format, larger than 1 MB,
cut, or an error), the check says it could not check, with the reason; it does not pass the page.

## Example

Against the invented `sveltekit-like` fixture, a climbing gym copied from a preview build and
served from an earlier deploy, run with `--owner-consent` because the owner agreed to it, version
0.1.0 prints:

```text title=Output
✗ This page tells Google to show a different page
    <link rel="canonical" href="https://cragnorth-git-main-team.vercel.app/"> on http://cragnorth.test/ (differs by scheme, host)
✗ A page address returns SvelteKit data, not a page
    the sitemap lists 1 data address
✗ Anyone can switch on preview mode
    /api/preview set preview_session with no secret
✗ The live SvelteKit site points search engines at a preview deployment
    canonical https://cragnorth-git-main-team.vercel.app/ is on a preview domain
✗ The data sent with a page has fields that look private
    the embedded state has apiToken; /__data.json has apiToken (field names only)
✗ One address serves a page and JSON, and caches aren't told
    The address returns HTML to a browser and JSON to Accept: application/json, and neither response lists Accept in Vary: a shared cache can hand the JSON to a visitor
! The page is from an older build than the site
    the page was built as version 1731000000000 and /_app/version.json says 1731099999999
· The page's data has text the page does not show
    /__data.json has 1 text field not on the page: coachNotes (field names only)
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

8 to look at, 6 to fix first.
```

`canonical-elsewhere` reports the same canonical from the search side. Each check that passed also
prints a `✓ <id>` line, left out above. The output is asserted by
`packages/cli/src/__tests__/sveltekit.test.ts`.

## What was looked up

Every address and marker comes from the SvelteKit source and docs, read on 11 November 2026
(`@sveltejs/kit` 3.2.0 from npm, and the docs in the project's GitHub repository), because
`svelte.dev` was not reachable from the build machine and no live SvelteKit site was reachable to
look at. The fixtures are invented and reproduce the structure that source writes.

- `__data.json` and `.html__data.json`: `src/pathname.js`; its shape (`{"type":"data","nodes":[...]}`,
  each node's `data` a devalue array) and its `application/json` or `text/sveltekit-data` content
  type: `src/runtime/server/data/index.js`, `src/runtime/server/page/data_serializer.js`.
- The bootstrap script, its `version` and `node_ids`/`data` arguments, and the `x-sveltekit-page`
  header: `src/runtime/server/page/render.js`. The `__sveltekit_dev` global:
  `src/core/utils.js`.
- `<appDir>/version.json`: `src/exports/vite/build/index.js`.
- `Vary: Accept` for a route with a page and an endpoint, and the rule that picks the page or the
  endpoint by `Accept`: `src/runtime/server/respond.js` and the routing docs
  ("Content negotiation").

Uncited, and said so in each check's technical line: the preview route names and the preview or
draft cookie rule (SvelteKit has no built-in draft mode; these are conventions of CMS starters),
and the words that mark a field name as private.

## Not checked

Stale pages are compared by build version only; there is no check of `kit.version.pollInterval`
(it is not visible from outside). Dev-only paths and the `__data.json` of pages nobody links to are
not requested. Discovery still follows `/_app/` and `__data.json` links as it would any link: a
later version can ignore them the way it does for Next.js.

# Remix and React Router sites

A ceramics shop, a pop-up bakery or a physio clinic built on Remix or React Router 7 sends the
browser more than the page. Every loader's result travels with the page, there is a data address
behind every route (`<page>.data`, or `?_data=` on Remix v2), and a preview build can leak into the
live site. These checks look at that, using only what the site already serves to every visitor, plus
one switch for the part that asks a route a visitor would not normally ask.

## How a Remix or React Router site is recognised

From its responses: the `X-Remix-Response` header on a data answer, or the context the page embeds
for the browser: `window.__reactRouterContext` (React Router 7), `window.__remixContext` (Remix v2),
`window.__staticRouterHydrationData` (a React Router data router rendered on the server), or the
`__reactRouterManifest` and `__remixManifest` globals. On any other site the checks below are not
run.

## The checks

- `remix-draft-public` (fix first, **probing**): a conventional preview route (`/api/preview`,
  `/api/draft`, `/preview`, `/draft`) sets a cookie whose name contains `preview` or `draft` for a
  request that carried no secret. Each route is asked once with a plain `GET`; no secret is sent or
  guessed, and no action (a `POST`) is ever called. It runs only with `--owner-consent` (or a
  `gaugeline.consent.json`): **run only on sites you own or have permission to test**. Without
  consent it asks nothing and says so under "could not run".
- `remix-preview-canonical` (fix first): the canonical address, `og:url`, `og:image` or a sitemap
  entry of a production page is on a preview domain (`vercel.app`, `netlify.app`, `pages.dev`).
- `remix-data-as-page` (fix first): a page address answers with route data (content type
  `text/x-script`, or the `X-Remix-Response` header every data answer carries), or the sitemap lists
  `.data` or `?_data=` addresses, or the canonical is one. No extra request is made.
- `remix-private-fields` (fix first): the state embedded in the page, including the first streamed
  chunk of loader data, has fields named like something private (`password`, `token`, `secret`,
  `apiKey`, `internalNotes` and a few more, matched by word). **Names only, never values.** No extra
  request is made.
- `remix-dev-tools-live` (fix first): the page was served by the dev server (it loads
  `/@vite/client`, `/@react-refresh`, the `inject-hmr-runtime` module or the live-reload script).
  Read from the page already fetched.

Gaugeline does not ask for the `.data` or `?_data=` address of a page or a route: loader data of
other routes is not requested, and the data of the page being checked is read from the page itself.

Remix and React Router set no `Vary` header and serve data at a different address, not by content
negotiation, so there is no check of `Vary: Accept` on this pack (the Next.js and SvelteKit packs
have one for the routes that serve a page and JSON from one address).

When the state cannot be read (cut by the size limit, a truncated page, a stream that is not
turbo-stream, or deferred values after the first chunk) the check says it could not check, with the
reason; it does not pass the page.

## Example

Against the invented `remix-like` fixture, a ceramics shop copied from a preview build, run with
`--owner-consent` because the owner agreed to it:

<!-- fixture: remix-like -->

```sh title=Terminal
$ npx gaugeline marrowlane-ceramics.example --owner-consent
```

```text title=Output
✗ This page tells Google to show a different page
    <link rel="canonical" href="https://marrowlane-git-main-studio.vercel.app/"> on https://marrowlane-ceramics.example/ (differs by scheme, host, port)
✗ A page address returns Remix data, not a page
    the sitemap lists 1 data address
✗ Anyone can switch on Remix preview mode
    /preview set preview_session with no secret
✗ The live Remix site points search engines at a preview deployment
    canonical https://marrowlane-git-main-studio.vercel.app/ is on a preview domain
✗ The data sent with a Remix page has fields that look private
    __reactRouterContext has wholesaleToken (field names only)
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

5 to look at, 5 to fix first.
```

`canonical-elsewhere` reports the same canonical from the search side. Each check that passed also
prints a `✓ <id>` line, left out above.

## What was looked up

Every address and marker comes from the installed packages, read on 11 November 2026 (`react-router`
and `@react-router/dev` 7.18.5, `@remix-run/server-runtime`, `@remix-run/react` and `@remix-run/dev`
2.17.5, from npm), because `reactrouter.com` and `remix.run` were not reachable from the build
machine and no live site was reachable to look at. The fixtures are invented and reproduce the
structure that source writes.

- `window.__reactRouterContext = {...}` and the stream script
  (`streamController.enqueue(...)`, `.close()`): `lib/dom/ssr/components.tsx`.
- The turbo-stream layout (a flat array; objects as `{"_<i>": <j>}`; typed values as arrays that
  start with a string): `vendor/turbo-stream-v2/`.
- `window.__remixContext` with `state.loaderData` (no single fetch) and the same stream with it:
  `@remix-run/react` `components.js`, `@remix-run/server-runtime` `server.js`.
- `window.__staticRouterHydrationData = JSON.parse(...)`: `react-router` `lib/dom/server.tsx`.
- `.data` and `?_data=` requests, `text/x-script` and `X-Remix-Response: yes`:
  `lib/server-runtime/server.ts` and `single-fetch.ts`.
- Dev-server modules (`virtual:react-router/inject-hmr-runtime`, `virtual:remix/inject-hmr-runtime`,
  `/@id/__x00__` URLs, `remixLiveReloadConnect`): `@react-router/dev` `vite.js`,
  `@remix-run/dev` `vite/plugin.js`, `@remix-run/react` `components.js`.

Uncited, and said so in each check's technical line: the preview route names and the preview or draft
cookie rule (neither framework has a built-in draft mode; these are conventions of CMS starters), and
the words that mark a field name as private.

## Not checked

Loader data of other routes (`?_data=routes/x`, `<path>.data`) is not requested; a later probing
check could do that with `--owner-consent`. Values streamed after the first chunk (deferred loader
data) are not read. Discovery still follows `.data` links as it would any link.

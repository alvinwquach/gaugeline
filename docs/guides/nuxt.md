# Nuxt sites

Freelancers and small agencies build a lot of small-business sites on Nuxt: a bakery's price list, a
clinic's booking page, a coach's launch page. It has its own quiet failures: a preview build that
went live, a development server left running, a secret that rode along in the page's data, and
addresses that are data files, not pages.

## How a Nuxt site is recognised

From its responses: an `x-powered-by: Nuxt` header (Nuxt's renderer and its payload route send it),
or, when a proxy strips that, its HTML: the `__NUXT_DATA__` script, a `data-nuxt-data` attribute,
`window.__NUXT__`, or scripts under `/_nuxt/` (the default `buildAssetsDir`). On any other site the
checks below are not run. Nothing is requested to decide this.

## Framework addresses are ignored

Build output (`/_nuxt/...`), page payloads (`_payload.json`, or `_payload.js` when JSON payloads are
off), island components (`/__nuxt_island/...`) and the DevTools address (`/__nuxt_devtools__/...`)
are not pages. Discovery leaves them out of the link and sitemap samples, never requests them, and
the summary says how many it ignored, for example `2 framework addresses ignored.`

## The checks

These read the page, its headers and its sitemap, which every visitor gets. They are on by default.

- `nuxt-preview-canonical` (fix first): the canonical address, `og:url`, `og:image`, an `hreflang`
  alternate or a sitemap entry of a production page is on a preview domain (`vercel.app`,
  `netlify.app`, `pages.dev`) or a local address. With `@nuxtjs/i18n` the alternates are built from
  its `baseUrl`, so a preview value there ends up in every language version.
- `nuxt-private-state` (fix first): the page's embedded state (the `__NUXT_DATA__` script, or the
  page's own `_payload.json` when the script points at one) or its public runtime config
  (`window.__NUXT__.config`) has a field named like a secret, password, private key, service role
  key, access token or API key, with a value in it. Only the field names and where they were found
  are shown, never a value. A field with an empty, null or true/false value is not reported. A name
  that is only an API key is medium, because some API keys are meant to be public.
- `nuxt-dev-build-live` (fix first): the page loads Vite's dev server client (`/_nuxt/@vite/client`)
  or other dev-only files, or its payload carries the DevTools state. A production build never does.
- `nuxt-framework-file-listed`: the sitemap, the canonical, `og:url` or an `hreflang` alternate
  names a `_payload.json`, a `/_nuxt/` file or an island as if it were a page.
- `nuxt-page-cache-header`: the page's `Cache-Control` says `immutable` or a year or more (a
  `routeRules` `headers` entry meant for `/_nuxt/**` that matched every route), or the page sets a
  cookie while shared caches may keep it.

The embedded state is read as text and never run: a flat JSON array with a size limit (2 MB), and a
single bounded scan of the config literal. A page that is cut at the size limit, a payload that is
too large or not JSON, or a payload file that does not answer is listed as could not check with the
reason, never as a pass.

## Probing checks: run only on sites you own or have permission to test

Two checks ask for an address the site does not link to, so they are off unless you pass
`--owner-consent` (or keep a `gaugeline.consent.json`, see [protected routes](/protected-routes)).
Run only on sites you own or have permission to test. Each asks once with a plain `GET`, sends no
cookie, no header and no secret, and the answers are never kept.

- `nuxt-preview-public` (fix first): the page's own address with `?preview=true` (the default query
  of `usePreviewMode`) is asked once. If the server's own state in the answer says preview mode is on
  (`enabled: true`) with no secret, anyone can switch it on. A page that never sends preview state,
  or whose answer cannot be read, is listed as could not check.
- `nuxt-devtools-public` (fix first): `/__nuxt_devtools__/client/`, where the DevTools module serves
  its page under `nuxt dev`, is asked once per site. Only a 200 HTML answer whose text includes
  "Nuxt DevTools" is reported; a 404 is the right answer on a live site.

## What is not checked, and why

- A missing `Vary` on an address that serves both a page and data: Nuxt serves page data at its own
  address (`<page>/_payload.json`), not as a second format at the page's address, so there is
  nothing to vary. The React Server Components check `rsc-vary-missing` still covers other
  frameworks.
- `routeRules` cache freshness against edits (the Next.js `next-stale-after-publish` counterpart)
  needs a connected content source, which arrives with the CMS adapters; it is not part of this
  version.
- Whether the `generator` meta tag names Nuxt: Nuxt does not add one by default, so it is not used.

## Example

Against the invented `nuxt-like` fixture, a bakery copied from a development build, version 0.1.0
prints:

```text title=Output
✗ This page tells Google to show a different page
    <link rel="canonical" href="https://marrow-rye-git-main.vercel.app/"> on http://marrow-rye.test/ (differs by scheme, host)
✗ This Nuxt site is running its development server
    the page loads /_nuxt/@vite/client
✗ The live Nuxt site points search engines at a preview or local address
    canonical https://marrow-rye-git-main.vercel.app/; hreflang alternates https://marrow-rye-git-main.vercel.app/, https://marrow-rye-git-main.vercel.app/fr are on a preview or local address
✗ A Nuxt page sends fields that look private to every visitor
    3 fields in the page's embedded state look private: mailgunApiKey (an API key, in the public config), stripeSecretKey (a secret, in the payload), supabaseServiceRole (a service role key, in the payload). Values are not shown
! A language version of this page is missing
    2 of 2 language versions are missing: en https://marrow-rye-git-main.vercel.app/ did not answer, fr https://marrow-rye-git-main.vercel.app/fr did not answer
! Menu items go to the homepage
    1 menu item goes to /: "Marrow & Rye"
! A Nuxt data file is named as a page
    the sitemap lists http://marrow-rye.test/_payload.json, http://marrow-rye.test/menu/_payload.json
! A Nuxt page is cached in a way that will show old or other people's content
    its Cache-Control says immutable
· Shared links have no picture
    no og:image on http://marrow-rye.test/
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

2 framework addresses ignored.
9 to look at, 4 to fix first.
```

`canonical-elsewhere` reports the same canonical from the search side. Each check that passed also
prints a `✓ <id>` line, left out above. The two probing checks did not run.

## Example with consent

The same site with `--owner-consent`, as the bakery's owner has agreed to:

```text title=Output
✗ This page tells Google to show a different page
    <link rel="canonical" href="https://marrow-rye-git-main.vercel.app/"> on http://marrow-rye.test/ (differs by scheme, host)
✗ This Nuxt site is running its development server
    the page loads /_nuxt/@vite/client
✗ The Nuxt DevTools are reachable
    /__nuxt_devtools__/client/ answered 200 with the Nuxt DevTools page
✗ The live Nuxt site points search engines at a preview or local address
    canonical https://marrow-rye-git-main.vercel.app/; hreflang alternates https://marrow-rye-git-main.vercel.app/, https://marrow-rye-git-main.vercel.app/fr are on a preview or local address
✗ Anyone can switch on Nuxt preview mode
    asked with ?preview=true and no secret, the page was rendered with preview mode on (enabled: true)
✗ A Nuxt page sends fields that look private to every visitor
    3 fields in the page's embedded state look private: mailgunApiKey (an API key, in the public config), stripeSecretKey (a secret, in the payload), supabaseServiceRole (a service role key, in the payload). Values are not shown
! A language version of this page is missing
    2 of 2 language versions are missing: en https://marrow-rye-git-main.vercel.app/ did not answer, fr https://marrow-rye-git-main.vercel.app/fr did not answer
! Menu items go to the homepage
    1 menu item goes to /: "Marrow & Rye"
! A Nuxt data file is named as a page
    the sitemap lists http://marrow-rye.test/_payload.json, http://marrow-rye.test/menu/_payload.json
! A Nuxt page is cached in a way that will show old or other people's content
    its Cache-Control says immutable
· Shared links have no picture
    no og:image on http://marrow-rye.test/
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

2 framework addresses ignored.
11 to look at, 6 to fix first.
```

The two probing checks add the DevTools page and the preview query. The outputs are asserted by
`packages/cli/src/__tests__/nuxt.test.ts`.

## Sources

Everything above was checked against Nuxt's own documentation and the published source. nuxt.com
itself could not be reached from the build environment, so the documentation pages were read from
the published `@nuxt/docs` package (version 4.4.8), which holds the same pages, and the source of Nuxt, Nitro's Nuxt server and the Nuxt DevTools module, not memory:

- `usePreviewMode`: the default is a `preview` query equal to `true`, with `token` stored in state
  (nuxt.com/docs/api/composables/use-preview-mode, [docs]).
- `__NUXT_DATA__`, `window.__NUXT__.config` and `_payload.json` (the renderer's `x-powered-by: Nuxt`
  header, the `data-src` attribute and the preloaded `_payload.json`) are read from the renderer's
  source in `@nuxt/nitro-server` ([docs], source). The Nuxt documentation names `_payload.json` under
  prerendering and `experimental.payloadExtraction`.
- `/_nuxt/` as the default `buildAssetsDir` (nuxt.com/docs/api/nuxt-config#buildassetsdir, [docs]).
- `routeRules` `headers`, `swr` and `isr` add cache headers (nuxt.com/docs/guide/concepts/rendering,
  [docs]).
- The DevTools module registers `/__nuxt_devtools__/client` and runs only under `nuxt dev` (source of
  `@nuxt/devtools`, [docs]); the title text "Nuxt DevTools" and the `/_nuxt/@vite/client` dev script
  are read from the module's and Vite builder's source and are `uncited` in the documentation.
- `@nuxtjs/i18n` needs `baseUrl` to build hreflang links, and sets `x-default` from `defaultLocale`
  (module source, `uncited` in the documentation pages, which could not be fetched).

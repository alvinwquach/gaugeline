# Astro sites

Astro builds a site from pages and components, ships almost no JavaScript, and loads a small
interactive component (an "island") only where a page needs one. That makes it a favourite for
studio, class and blog sites. It also has its own quiet failures: a dev server left running, a
preview address that leaks into the canonical, and props that carry more than the page shows.

These checks read the page Gaugeline already fetched. None of them requests a non-public address,
so none is a probing check, and none needs `--owner-consent`.

## How an Astro site is recognised

From its HTML: an `astro-island` element, a `data-astro-cid-*` attribute (scoped styles), a
`meta name="generator"` of `Astro vX`, a script or stylesheet under `/_astro/` (the default build
folder), or a server-island script. On any other site the checks below are not run.

## The checks

- `astro-dev-tools-public` (fix first): the page loads the Vite dev client (`/@vite/client`), the
  Astro dev toolbar, or carries `data-astro-source-file` attributes. A built site has none of them;
  they mean the host is running `astro dev`.
- `astro-preview-canonical` (fix first): the canonical address, `og:url`, `og:image` or a sitemap
  entry of a production page is on a preview domain (`vercel.app`, `netlify.app`, `pages.dev`). The
  usual cause is `site` in `astro.config.mjs` set to a preview address.
- `astro-private-props` (fix first): a client island's props have a field named like a secret, token,
  password, internal note or admin value. Astro writes the props into the page as JSON, so anyone
  can read them. The finding shows the island and the field name and kind, never the value.
- `astro-draft-entry-public`: a field named `draft` (or `isDraft`) set to `true` in an island's
  props, the common convention for an entry the author has not published. Astro has no built-in
  draft field: collections define their own, so this reads the convention, not a setting.
- `astro-endpoints-listed` (worth knowing): the page calls Astro Actions (`/_actions/NAME`, or a
  form posting to `?_action=NAME`) or loads server islands (`/_server-islands/NAME`). Both are
  addresses anyone can request, and the names tell you the site runs on the server (an adapter) and
  not as a static build. Gaugeline never calls an action: they are POST endpoints and Gaugeline only
  reads.

## What is not checked

- Astro has no draft or preview route and no framework data files served as pages, so there is no
  equivalent of Next.js's `next-draft-public` or `_next/data` handling. Preview setups are
  per project (a CMS preview route, for instance), and an address that is not linked from the site
  is probing territory.
- The `/_image` endpoint (the image service on a server build) is not requested. Whether it
  optimises images from other sites is tested separately, on sites you own.
- A page cut at Gaugeline's size limit is searched up to the cut: a finding in what was read stands,
  but a page with no finding is not proof the unread part is clean.

## Sources

The addresses and markers come from the `astro` 7.4.11 and `@astrojs/runtime` 0.1.1 packages
(`dist/actions/consts.js`, `dist/core/server-islands/endpoint.js`, the island and server-island
renderers, the dev toolbar entrypoint) and from `astro.config` types for `build.assets` and
`output`. The documentation site, docs.astro.build, could not be reached when this was written, so
the draft-field convention and the `getCollection` filter in the fix text are `uncited`.

## Example

A yoga studio's blog on Astro, invented for the tests (the `astro-like` fixture): the site was copied
from a preview deployment while the dev server was still running, and the booking form is handed
its teacher's internal notes. Version 0.1.0 prints:

```text title=Output
✗ The live Astro site is serving its development tools
    the page carries the Vite dev client (/@vite/client), data-astro-source-file attributes
✗ The live Astro site points search engines at a preview deployment
    canonical https://fernlight-yoga-git-main.vercel.app/ is on a preview domain
✗ A page hands private-looking fields to the browser in an island's props
    2 private-looking fields in island props: BookingForm.apiToken (string), BookingForm.teacher.internalNotes (string)
✗ This page tells Google to show a different page
    <link rel="canonical" href="https://fernlight-yoga-git-main.vercel.app/"> on http://fernlight.test/ (differs by scheme, host)
✗ Google sees an almost empty page
    36 words in the server-rendered HTML outside header, nav and footer (fewer than 60)
! A live page embeds a content entry marked as a draft
    a draft flag set to true in island props: Newsletter.draft
! Search engines can't find a list of your pages
    http://fernlight.test/sitemap.xml returned 404; there is no robots.txt
· This Astro page calls public endpoints that need a second look
    the page calls actions subscribe, bookClass and loads server island NextClass
? form-redirect-leaks-details could not be checked: 1 form has no address of its own to read (no action, or an action of # or javascript:) and no thank-you field, so where it sends a visitor is only known after it is submitted or a script runs (/)
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

8 to look at, 5 to fix first.
```

Each check that passed also prints a `✓ <id>` line, left out above. The output is asserted by
`packages/cli/src/__tests__/astro.test.ts`.

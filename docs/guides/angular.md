# Angular sites

Angular with server rendering (and Analog, the meta-framework built on Angular) is a common choice for
clinic, booking and member sites: pages arrive as real HTML, then the app takes over in the browser.
It has its own quiet failures: a dev server left running, a preview address in the canonical, a
transfer state that carries more than the page shows, and a render error served as a normal page.

These checks read the page Gaugeline already fetched. None of them requests a non-public address,
so none is a probing check, and none needs `--owner-consent`.

## How an Angular site is recognised

From its HTML: the root element's `ng-version` or `ng-server-context` attribute (written by the server
renderer), or the transfer-state script, an `application/json` script whose id is the app id plus
`-state` (`ng-state` by default, `serverApp-state` in older Universal apps). On any other site the checks
below are not run.

## The checks

- `angular-dev-tools-public` (fix first): the page loads the Vite dev client (`/@vite/client`), the
  dev server's component update address (`/@ng/component`) or an `/@analogjs/` module. A built site has
  none of them; they mean the host is running `ng serve` or `analog dev`.
- `angular-preview-canonical` (fix first): the canonical address, `og:url`, `og:image` or a sitemap
  entry of a production page is on a preview domain (`vercel.app`, `netlify.app`, `pages.dev`).
- `angular-state-private-fields` (fix first): the transfer state has a field named like a secret, token,
  password, internal note or admin value. Angular writes everything stored in `TransferState`, and every
  cached `HttpClient` response, into the page as JSON, so anyone can read it. The finding shows the
  field name and kind, never the value. A state that is too large or not JSON is reported as not
  checked, with the reason, and not as clean.
- `angular-ssr-error-200`: the page answers 200 but its text contains an Angular error code (`NG0xxx:`),
  an injector error, a `ReferenceError` for `window` or `document` (browser-only code run on the
  server), or a stack trace through `node_modules/@angular/`. A page that explains such an error on
  purpose (a tutorial, say) can trigger it; the finding says what was seen so you can judge.
- `angular-analog-endpoints-listed` (worth knowing): the page names an Analog server function
  (`/_analog/fn/ID`) or a page endpoint (`/api/_analog/pages/PATH`). Both are addresses anyone can
  request. Gaugeline never calls them: a server function can be a POST and Gaugeline only reads.

`ng-version` and `ng-server-context` are used to recognise the site and are never reported on their
own: every Angular page carries them.

## What is not checked

- Angular has no draft or preview route, no framework data files served as pages and no addresses that
  serve both a page and data, so there is no equivalent of the Next.js `next-draft-public`, `_next/data`
  handling or a missing `Vary` check. Analog's page endpoints (`/api/_analog/pages/...`) only answer
  with data; requesting ones the page does not name would be probing, and is not done.
- Analog API routes that the site does not name, and dev-server addresses such as `/@vite/client`
  requested directly, are probing territory: off by default, and only ever for sites you own or have
  permission to test.
- A page cut at Gaugeline's size limit is searched up to the cut: a finding in what was read stands,
  but a page with no finding is not proof the unread part is clean.

## Sources

The markers come from the installed packages: `@angular/platform-server` 22.2.5 (the state script id
`<appId>-state` with type `application/json`, the `ng-server-context` attribute and its values `ssr`,
`ssg`, `other`), `@angular/core` 22.2.5 (`ng-version`, `TransferState.toJson`, the `NG0xxx` message
format), `@angular/common` 22.2.5 (the HttpClient transfer-cache entry shape `b`, `h`, `s`, `st`, `u`,
`rt`), `@angular/build` 22.2.6 (`/@ng/component`) and `@analogjs/router` 2.9.7 (`/_analog/fn/ID`,
`/api/_analog/pages/PATH`) [docs: package source]. angular.dev and analogjs.org could not be reached when
this was written, so the guidance that private values do not belong in `TransferState`, the Vite dev
client address for `ng serve` and the 500-versus-200 advice in the fix text are `uncited`.

## Example

A physiotherapy clinic's booking site on Angular SSR, invented for the tests (the `angular-like`
fixture): copied from a preview deployment with the dev server still running, its booking data
cached into the page with the staff's private fields, and an error shown with a 200. Version 0.1.0
prints:

```text title=Output
✗ The live Angular site is serving its development tools
    the page carries the Vite dev client (/@vite/client)
✗ The live Angular site points search engines at a preview deployment
    canonical https://harbourside-physio-git-main.vercel.app/ is on a preview domain
✗ A page hands private-looking fields to the browser in its transfer state
    3 private-looking fields in the transfer state: clinic.adminToken (string), http-cache[0].internalNotes (string), http-cache[0].slots[].wholesaleRate (number)
✗ This page tells Google to show a different page
    <link rel="canonical" href="https://harbourside-physio-git-main.vercel.app/"> on http://harbourside.test/ (differs by scheme, host)
✗ Google sees an almost empty page
    45 words in the server-rendered HTML outside header, nav and footer (fewer than 60)
! An Angular error is served as a normal page
    the page answers 200 and contains an Angular error code (NG0...), a stack trace through @angular
! Search engines can't find a list of your pages
    http://harbourside.test/sitemap.xml returned 404; there is no robots.txt
· This Analog page calls public endpoints that need a second look
    the page names server function c3b1e9a2 and page endpoint /api/_analog/pages/exercises
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

8 to look at, 5 to fix first.
```

Each check that passed also prints a `✓ <id>` line, left out above. The output is asserted by
`packages/cli/src/__tests__/angular.test.ts`.

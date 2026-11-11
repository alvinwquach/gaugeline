# Error pages that answer 200

A page that is broken but answers `200 OK` is the quietest failure a site has. Google, other crawlers
and your own uptime monitor all believe the status code, so a "Page not found" page that says 200 stays
in search results (Google calls it a soft 404), and nothing reports the error. This applies to every
framework, and to sites with no framework at all.

Two checks look at it from two sides.

## `error-shell-200`: a page the site serves that is an error

It reads the checked page and the same-site pages the run already fetched, and asks of each page that
answered 2xx with HTML: is this page an error? **It makes no request of its own.** A page counts when it
carries one of these markers:

- the Next.js error page: an `<html id="__next_error__">` element, or the "Application error: a
  client-side exception has occurred" message;
- the Nuxt error page: a title like `404 - Page not found | Site` and its "go back home" link;
- the SvelteKit error template: a status number and the error message as both title and heading;
- the React Router and Remix default error boundary ("Unexpected Application Error!");
- a title, or the first heading, that is wholly an error phrase ("Page not found", "404", "Something
  went wrong", "Internal Server Error", and the same in Spanish, French, German, Italian, Portuguese and
  Dutch), on a page with fewer than 150 visible words.

A real article titled "Page not found: a history" is not flagged: the phrase has to be the whole title
(apart from a status number or a site name after a `|` or a dash), and the page has to be short. A page
whose body was cut at the size cap, with no marker in what was read, is listed as could not check. A
finding shows the address and the kind of marker, never a word from the page.

Each framework's own pack can say more about its own error pages; this check is the one every site gets.

## `not-found-200`: what the site does for an address that does not exist

One `GET` of `/gaugeline-not-found-3f9c2a71` on the checked page's own origin, with no cookie and nothing
sent: a site that answers 200 for it (or redirects it to a page that answers 200, such as the home page)
treats every mistyped or deleted address as a real page. 404 and 410 pass. 401, 403, 429, a server error
or no answer are listed as could not check.

This is a **probing check**: it asks for an address the site does not have, so it is off by default and
runs only with `--owner-consent` (or a `gaugeline.consent.json`), on sites you own or have permission to
test. Without consent it is listed as could not check, with the reason.

## Example: a bookshop whose events and gift cards pages are errors

Harbour Lane Books is an invented independent bookshop. A freelancer built the site and handed it over.
Months later the reading-evenings page throws on a missing field and renders the framework's error page,
the gift-cards page renders "Page not found" because the product was renamed, and the host rewrites every
unknown address to the home page. Every one of them answers 200, so the uptime monitor is green.

<!-- fixture: error-pages -->

```sh title=Terminal
$ npx gaugeline harbour-lane.example --owner-consent
```

```text title=Output
✗ A page that is an error says everything is fine
    https://harbour-lane.example/events/readings answers 200 but shows the Next.js error page (an html element with the id __next_error__)
✗ A page that is an error says everything is fine
    https://harbour-lane.example/shop/gift-cards answers 200 but shows a page title that says the page is an error or is not found
! Pages that do not exist answer 200
    /gaugeline-not-found-3f9c2a71 answers 200, not 404
· Shared links have no picture
    no og:image on https://harbour-lane.example/
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

4 to look at, 2 to fix first.
```

Each check that passed also prints a `✓ <id>` line, left out above. The output is asserted by
`packages/cli/src/__tests__/error-pages.test.ts` and `pnpm docs:examples`.

The first two findings are pages the site links to. The fix is the status, not the message: call
`notFound()` in Next.js, `createError({ statusCode: 404 })` in Nuxt, `error(404, ...)` in SvelteKit, or
throw a `Response` with status 404 in Remix, so the page keeps its friendly design and answers 404. The
third finding is the host's catch-all: add a 404 rule for unknown paths, or a real not-found route.

## Limits

- The words are matched against a fixed list. A custom error page in another language, or with its own
  wording ("Oops, this book wandered off"), is not recognised, and the check passes it. Passing means
  none of the markers above were found, not that every page is healthy.
- Pages that are listed in the sitemap but not linked from the checked page are not read: reading them
  would be a request of its own.
- The first 200,000 characters of each page are scanned; error pages are far smaller than that.

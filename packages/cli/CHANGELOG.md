# gaugeline

## 0.1.0

### Minor Changes

- Headline: The site check
- ffc89e9: AI assistants: see which assistants can read your site, and whether the facts they'd quote agree. Four new checks report AI crawlers blocked by robots.txt, broken links and stale phone numbers, addresses or hours in llms.txt, and a business name that differs between llms.txt and the structured data.
- 56e7b26: App store links: checks that the app your site links to is still live. Up to 5 App Store and Google Play apps on the page are looked up, and an iPhone app banner that names a different app is reported.
- 2f455f8: One command checks a page. --ci exits 1 on fix-first findings; --json prints a versioned result.
- 5c42e52: Image checks: broken images, missing descriptions, very large pictures and old formats. Seven checks read image headers only, for up to 20 images on the page.
- 74702a7: Gaugeline now counts how much of the page each run samples (for example 30 of 61 links), so the summary can say how much was checked. The published limits live in one place and cannot be raised.
- 36dc67b: Link checks: links that go nowhere and links that go through a redirect. Up to 30 same-site links on the page are checked, the same ones every run.
- 429aba2: Adds --verbose for request-level detail and --quiet for silence; progress lines always go to stderr so piped output stays clean.
- 35628e5: Page weight checks, plus the phone-screen setup and phone link format. Five checks use only what the run already fetched: very large HTML, HTML that is mostly a data payload, a heavy page, a missing viewport tag and tel: links with spaces or brackets.
- 291d9f8: The shape of --json output is now published as a JSON Schema (schema/result.v1.json) that scripts can validate against.
- 7ae21d3: Robots, sitemap and feed checks: eight new checks catch a robots.txt that blocks every search engine, a missing sitemap, sitemap entries that are dead, redirect or sit on another host, and advertised feeds that are broken, not a feed, or over 2 MB.
- 65eccc4: Six search checks: canonicals, duplicate hosts, empty pages, noindex, redirect chains.
- 5547088: Gaugeline now refuses to request loopback, private, link-local (including 169.254.169.254) and other non-public addresses, on the first request and on every redirect, and connects only to the address it checked. Pass --allow-private to check a site on your own computer or network.
- b3f595a: Structured data and share preview checks: broken JSON-LD, structured data that points at dead pages or is written twice, share tags (og:url and og:image) that are missing or wrong, and hidden editing characters leaked onto the live site.

### Patch Changes

- 5808e88: The --help text and the Options page now come from the same list, and a mistyped flag suggests the nearest real one.
- 5a74539: Flags and check ids that are going away now print one warning with the version they will be removed in.
- 8700d27: When a check cannot run, Gaugeline now prints one plain sentence and a suggestion in place of a stack trace. Add --verbose for the technical detail.
- 4c8aa88: First published package: npx gaugeline downloads one package with no dependencies and runs on Node.js 18.17 or newer.

# Every check

Each check has a stable id, an area, a severity and four lines: what it catches, why it matters,
how to fix it, and the technical line for whoever fixes it.

Severities:

| Severity | Label          | Meaning                                   |
| -------- | -------------- | ----------------------------------------- |
| `high`   | Fix this first | `--ci` exits 1 when one of these is found |
| `medium` | Fix soon       |                                           |
| `low`    | Worth knowing  |                                           |

Areas: Search & sharing, Visitors, Sales & prices, Leads, Security & email, Launch day.

<!-- Until K06 generates this list from the registry, entries are written by hand from the catalogue. -->

## Search & sharing

### `canonical-elsewhere`

**This page tells Google to show a different page** · Fix this first (`high`)

- **What it catches:** The page's canonical tag names a different address as the real one.
- **Why it matters:** Search engines treat the page as a copy, so it may never appear in results.
- **How to fix it:** Give each page a canonical tag that points at its own address. Shared SEO components are the usual cause.
- **Technical line:** `<link rel="canonical"> on the page points at another URL`

### `host-duplicate`

**Your whole site exists at two addresses** · Fix this first (`high`)

- **What it catches:** Both www and the bare domain load the site, instead of one redirecting to the other.
- **Why it matters:** Search engines can split your ranking between two copies of every page.
- **How to fix it:** Pick one address and 301-redirect the other to it at your host or DNS provider.
- **Technical line:** `the alternate host returns 200 instead of 301`

### `thin-html`

**Google sees an almost empty page** · Fix this first (`high`)

- **What it catches:** Fewer than 60 words exist in the page before JavaScript runs, outside the header, nav and footer.
- **Why it matters:** Many crawlers and AI tools read the page without running JavaScript, so they see almost nothing.
- **How to fix it:** Render the main content on the server. In Next.js, keep it out of client-only components and Suspense boundaries that wait for the browser.
- **Technical line:** `word count of server-rendered HTML`

### `noindex`

**This page asks search engines not to list it** · Fix this first (`high`)

- **What it catches:** The page has a robots meta tag containing noindex.
- **Why it matters:** If that isn't on purpose, the page is invisible in search.
- **How to fix it:** Remove noindex from pages you want found.
- **Technical line:** `<meta name="robots" content="noindex">`

### `redirect-chain`

**Your address takes several jumps to load** · Fix soon (`medium`)

- **What it catches:** The address you entered redirects more than once before the page loads.
- **Why it matters:** Each jump slows the first visit and can weaken how search engines credit the page.
- **How to fix it:** Point every redirect straight at the final address.
- **Technical line:** `more than one 3xx hop on the entered URL`

### `canonical-missing`

**The page doesn't say which address is the real one** · Worth knowing (`low`)

- **What it catches:** There's no canonical tag.
- **Why it matters:** Copies of the page with tracking parameters can be treated as separate pages.
- **How to fix it:** Add a self-referencing canonical tag.
- **Technical line:** `no <link rel="canonical">`

#### Notes on how these six decide

- `canonical-elsewhere` ignores a trailing slash, but a different scheme, `www`, host, path or a
  canonical carrying its own query string is a finding. A canonical that drops the page's tracking
  query (`?utm_source=...`) is correct.
- `host-duplicate` asks the other spelling of the host (`www.` added or removed) for `/` once. A
  `200` there is the finding; a redirect, or no such host at all, is not.
- `thin-html` counts words outside `header`, `nav` and `footer`, before any JavaScript runs.
- `noindex` reads the robots meta tag and the `X-Robots-Tag` header.

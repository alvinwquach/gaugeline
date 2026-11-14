# ADR-0015: Speed from Google's PageSpeed Insights: one GET host, real visitors decide, no key, no POST

Status: proposed Date: 2026-11-13

## Context

The performance pack (PERF-01) wants two things for each key page: a Lighthouse run on a simulated phone (lab
data) and what real visitors' Chrome measured (Core Web Vitals from the Chrome UX Report, field data). They
are different facts and are reported apart. Real visitors decide pass or fail; a lab score is advice.

Three questions had to be settled before a line was written.

- **Where does the key go?** The reference for both APIs puts the key in the query string (`key=`), and
  decision 53 allows no key in an address. The vendors' pages that might document a header were not reachable
  from the build session, so the header is not confirmed.
- **Which hosts?** ADR-0003 says a run contacts no host the person did not name. PageSpeed Insights is a third
  party. The Chrome UX Report API is another host, and its only way to ask for a record, `records:queryRecord`,
  is a `POST` (and `records:queryHistoryRecord`, also a `POST`).
- **Which browser?** Lighthouse needs one. The renderer (ADR-0009) puts a browser behind an egress gate that
  stops every request but `GET` and `HEAD`; Lighthouse drives a browser itself and would go round that gate.

## Decision

1. **One host, one method.** `--pagespeed` makes one `GET` per page to `pagespeedonline.googleapis.com`
   (`/pagespeedonline/v5/runPagespeed`, strategy `MOBILE`, category `PERFORMANCE`), through the fetcher, and
   asks no other host. The host is the registered list in `packages/core/src/pagespeed/reader.ts`
   (`PAGESPEED_HOSTS`); a test asserts every request of a run is to a host on it.
2. **No Chrome UX Report API call.** PageSpeed Insights' answer already carries the Chrome UX Report's
   figures for the address, and for the whole site when the page has too few visitors (`loadingExperience`,
   `originLoadingExperience`). That is a `GET` route to the same data, so `records:queryRecord` is not used
   and `fetcher.query` (ADR-0006) is not touched: no allowlist entry is added, and the rule that only an
   adapter's file may `POST` stands. The Chrome UX Report host is therefore not registered. If a later row
   needs figures the PageSpeed answer lacks (history, a connection type), it adds an ADR-0006 entry for
   `records:queryRecord` from an adapter's file, once the key's header is confirmed.
3. **Keyless.** No key is read from the environment or the configuration and none is sent: not in the address
   (decision 53), not in a header. Without a key the quota is shared with every other keyless caller, and
   Google answers `429` when it is used up (it did, when one real answer was asked for while this record was
   written). That answer is could-not-check with the reason, never a pass, and is not retried. A key is added
   only after a vendor page confirms `x-goog-api-key` (or another header) for these APIs; it would come from
   the environment and never reach a log, a finding or a report.
4. **Real visitors decide.** The field check reads the buckets of each metric: a vital is good when at least
   75% of loads are in the good bucket, which is exactly "the 75th percentile is within web.dev's limit",
   and poor when more than 25% are in the poor bucket. The answer's own `percentile` value is not used: the
   reference describes it as `pc90` for version 5, which is not the 75th percentile web.dev defines. The
   buckets must be web.dev's limits (2.5 s, 200 ms, 0.1) or the metric is could-not-check. The lab check is a
   separate check, severity low, advice only, and never a pass or a fail.
5. **Missing data is could-not-check.** No real-user data, a vital the answer lacks, buckets that are not the
   definition, a refusal, a timeout, an answer that is not a result, and an address Google cannot read
   (loopback, private, numeric, a name with no dot) are could-not-check. None is a pass.
6. **What leaves the machine.** The address of the page, without its query string, fragment, user name or path
   parameter, at most five pages per run (the checked page, then the first same-site pages of the run's sample),
   and only for a public page: nothing at all with `--allow-private`; no numeric address, single-label name,
   reserved or private-use ending (a trailing dot is dropped first) or wildcard-DNS name; no name that resolves,
   through the fetcher's resolver, to any private, loopback, link-local or metadata address (a failed lookup is a
   refusal); and no path unless it is the root or at most 6 parts and 120 characters, each a number of up to 4
   digits or a lowercase slug of whole words (at most 30 characters, no word over 20, no mixed letter-and-digit
   word, at most 4 digits in a slug and 8 in the path, no alternating letters and digits, no secret-looking
   word, nothing shaped like an email address): an allowlist that fails closed, not a list of bad shapes. A
   person's name or other detail written as a page-name slug cannot be detected by any rule; the flag is opt-in
   and says the address is sent. The calls to Google go one at a time, so they cannot fill the fetcher's slots. A
   run says so on stderr before the first request. The flag is off by default.
7. **No local Lighthouse yet.** Google runs Lighthouse on its servers, so no browser is needed here and the
   egress gate is not bypassed. Running Lighthouse on the person's own machine, behind the renderer's gate, is
   a separate decision: Lighthouse navigates by itself, so it needs the same interception the renderer has,
   and nobody has built or measured that.

## Alternatives

- **Call the Chrome UX Report API too.** Lost: its only method is a `POST` that needs a key, the key's header
  is unconfirmed, and the same figures arrive in the answer already fetched.
- **Put the key in the address, as the reference shows.** Lost: decision 53.
- **Run Lighthouse in the renderer's browser.** Lost for now: it would go round the egress gate (item 7).
- **Judge by the `percentile` value.** Lost: its meaning is contradicted by the vendor's own pages; the buckets
  say the same thing without it.
- **Let a lab score fail a page.** Lost: the owner decided real-user data decides.

## Cost

- A page's address goes to Google. A public page's address is not secret, but it is a request to a host the
  person did not type, so the flag is opt-in, announced on stderr, and listed in the privacy page.
- Without a key the quota is shared and often used up; the check then says could not check, often. A page
  with too few visitors has no figures of its own, and the whole site's are used and labelled.
- A page that is behind a login, on a staging address or on this computer cannot be read by Google at all.
- The metric names and the layout shift's bucket scale in the answer are read tolerantly (a name containing the
  vital's words; limits of 0.1 or 10) because the reference does not list them; an answer that differs is
  could-not-check, not a wrong verdict.

## What would change it

A vendor page confirming a header for the key (then keyed use becomes a small change), a need for history or
connection-type figures (then an ADR-0006 entry for `records:queryRecord`), or a measured local Lighthouse
behind the renderer's gate.

## Enforced by

- `packages/core/src/pagespeed/__tests__/reader.test.ts` (GET only; the one registered host; no key in the
  address and no header of ours; the address sent has no query string; nothing is sent for a private address;
  429 and other refusals are could-not-check and not retried)
- `packages/cli/src/__tests__/pagespeed.test.ts` (every request of a run to Google is a `GET` to a registered
  host, at most five pages, no query string and no key; off without the flag; a run on this computer sends
  nothing)
- `packages/core/src/__tests__/post-boundary.test.ts` (no file builds a `POST`, `PUT`, `PATCH` or `DELETE`
  outside the allowed ones; this change adds none)
- `packages/core/src/checks/__tests__/pagespeed.test.ts` (real-user data decides; a bad lab score never fails
  a page; missing data is could-not-check)

## Sources

1. PageSpeed Insights API reference (discovery document), `https://pagespeedonline.googleapis.com/$discovery/rest?version=v5`,
   revision 20261111: `runPagespeed` is a `GET` at `pagespeedonline/v5/runPagespeed` with `url`, `strategy`
   (`MOBILE`, `DESKTOP`) and `category` (`PERFORMANCE`) parameters; the answer's `loadingExperience` and
   `originLoadingExperience` hold buckets with `min`, `max` and `proportion`; `percentile` "for v5, this field
   contains pc90". [docs]
2. Chrome UX Report API reference (discovery document), `https://chromeuxreport.googleapis.com/$discovery/rest?version=v1`,
   revision 20261112: `records:queryRecord` and `records:queryHistoryRecord` are `POST`; `key` is a query
   parameter; `percentiles.p75` is "75% of users experienced the given metric at or below this value". [docs]
3. Core Web Vitals thresholds and the 75th percentile rule, `https://web.dev/articles/vitals`: not reachable from
   the build session, so the limits (2.5 s, 200 ms, 0.1 good; 4 s, 500 ms, 0.25 poor) are uncited here.
4. One keyless call to `runPagespeed` answered HTTP 429, `RESOURCE_EXHAUSTED`, "Quota exceeded ... Queries per
   day" for a shared consumer project: the evidence that a keyless run is quota-limited. [observed]
5. This repository: ADR-0001, ADR-0003, ADR-0006, ADR-0009, the project rules 6, 7 and 11, decision 53.

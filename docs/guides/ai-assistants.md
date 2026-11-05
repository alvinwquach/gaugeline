# How AI assistants read your site

People now ask an assistant "is the bakery open tonight?" before they open a site. These checks
look at what an assistant's crawler can reach, and whether the facts it would quote agree with
each other.

## What is checked

- **AI crawler rules in robots.txt** (`ai-crawlers-blocked`, Worth knowing). Gaugeline lists the
  known AI crawlers that robots.txt keeps away from the page, and says whether each block names the
  crawler (it looks intentional) or comes from a rule for every crawler, such as a `Disallow: /`
  left over from a staging site (it may be accidental). Blocking AI crawlers is a fair choice, so
  this is reported, never judged.
- **Links in llms.txt** (`llms-txt-broken-links`, Fix soon). [llms.txt](https://llmstxt.org/) is a
  short Markdown guide for assistants: a `#` title, a `>` summary, and `##` sections of links.
  Links that answer 4xx or 5xx, or redirect to another site, are listed.
- **Stale facts in llms.txt** (`llms-txt-stale-facts`, Fix soon). A phone number, street address
  or opening hours in llms.txt that disagree with the page's LocalBusiness structured data.
- **Two names for one business** (`quotable-facts-disagree`, Fix this first). The business name in
  the structured data and the title of llms.txt are different names. Until the facts model lands,
  this compares the structured data with llms.txt only; phone, address and hours disagreements there
  are reported once, as stale facts.

## How facts are compared

Comparison is conservative. A value that does not parse is not checked, and nothing is guessed:

- Phone numbers compare by their digits: `+1 (503) 555-0142`, `503.555.0142` and
  `tel:+15035550142` are one number. In llms.txt, only numbers on a line labelled phone, tel or call
  (or `tel:` links) are read, so a date or an order number is never taken for a phone number.
- Hours compare per day: `5pm`, `5:00 PM` and `17:00` are the same time, and `Mon–Fri`, `Mo-Fr` and
  `Monday to Friday` are the same days. A bare `9-5` is ambiguous and is not checked.
- Addresses compare the house number and a 5-digit ZIP code, nothing looser.

## The AI crawler list

The crawlers Gaugeline knows are data, in
[`packages/core/src/data/ai-agents.json`](https://github.com/alvinwquach/gaugeline/blob/main/packages/core/src/data/ai-agents.json):
each entry has the user-agent token, the owner, what it crawls for, the owner's documentation page
and the date it was last checked against that page. A test fails when any entry is more than 180
days old, so the list cannot quietly go out of date.

## Example

Against the invented `llms-stale` fixture, a bakery whose llms.txt still has last year's phone number
and Saturday hours, version 0.1.0 prints:

```text title=Output
! Your llms.txt sends assistants to pages that don't work
    2 of 3 links in llms.txt do not work: /catering (404), /order (redirects to http://orders.test/hollyhock)
! Your llms.txt gives assistants an old phone number, address or hours
    phone: llms.txt says (503) 555-0119, structured data says +1 503-555-0142. hours: Sat 08:00-13:00 in llms.txt, 08:00-14:00 in structured data

Checked 1 sitemap page, all 3 llms.txt links.
2 to look at, none to fix first.
```

These checks run from version 0.1.0; see [Quick start](../quick-start.md). Each check that passed also prints a `✓ <id>` line, left out above. The output is asserted by
`packages/cli/src/__tests__/ai-readability.test.ts`.

## What it requests

`/robots.txt` and `/llms.txt`, once each, and at most 10 of the links in llms.txt (the first 10 in
the file). See [Security](../security.md#how-much-a-run-requests).

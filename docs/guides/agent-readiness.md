# How AI agents read your site

A person asks an assistant "can Larkspur Family Law help with a custody case?" before they open the
site. Whether the assistant can answer from your pages depends on four things Gaugeline looks at:
what `robots.txt` says to each AI crawler, whether `llms.txt` is a usable guide, whether the
standard agent discovery files the site serves are valid, and whether your phone number and
address are written as text, not only in markup. Everything is read with plain GET requests, and
Gaugeline never calls a model.

This page covers the checks added for agent readiness. Two earlier checks are on
[How AI assistants read your site](ai-assistants.md): `ai-crawlers-blocked` (what robots.txt blocks)
and `llms-txt-broken-links` / `llms-txt-stale-facts` (what llms.txt links to and says).

## Say what you want: gaugeline.ai.json

Blocking AI crawlers is a fair choice and so is allowing them, so Gaugeline does not judge it. With
no settings, `ai-crawlers-blocked` only reports which known AI crawlers robots.txt keeps away. To
have robots.txt compared with what you want, put a `gaugeline.ai.json` in the folder you run
Gaugeline from:

```json
{ "aiCrawlers": "search-only" }
```

| Value            | Wants allowed                               | Wants blocked                                 |
| ---------------- | ------------------------------------------- | --------------------------------------------- |
| `allow`          | every known AI crawler                      | none                                          |
| `block`          | none                                        | every known AI crawler                        |
| `training-block` | search crawlers and user-triggered fetchers | crawlers that collect training data           |
| `search-only`    | crawlers that build a search index          | training crawlers and user-triggered fetchers |

The settings file has one key and nothing in it is a secret. With an intent set,
`ai-crawlers-intent` reports every crawler whose access is the opposite of it, and
`ai-crawlers-blocked` stays quiet so the same block is not reported twice. A site with no
robots.txt (404) has no rules, so every crawler is allowed: that disagrees with `block` and
`training-block` and is said plainly. A robots.txt that does not answer (a 5xx) is could-not-check,
never "allowed".

The crawlers and what each is for (training, search or a person asking) are data in
[`packages/core/src/data/ai-agents.json`](https://github.com/alvinwquach/gaugeline/blob/main/packages/core/src/data/ai-agents.json),
each with the vendor's page and the date it was last checked.

## What is checked

- **Your robots.txt does not do what you said you want for AI crawlers** (`ai-crawlers-intent`).
  Needs `aiCrawlers` above. Names the crawlers that are blocked and should not be, and those that
  are allowed and should not be, and how many are decided by the rule for every crawler.
- **Your llms.txt is not in the format assistants expect** (`llms-txt-malformed`). The file exists
  but has no `#` title, no `##` section with a list of links, or is over 200,000 characters. A
  site with no llms.txt gets no finding: the file is an optional convention, and a page that answers
  `/llms.txt` with HTML (a soft 404) counts as no file, not as a broken one. If the file is longer
  than the size Gaugeline reads, its format is not judged and the check is listed as could not check.
- **An agent discovery file on your site is broken** (`well-known-invalid`). Gaugeline asks for
  four documented paths, once each: `/.well-known/oauth-protected-resource`,
  `/.well-known/agent-card.json`, `/.well-known/agent.json` and `/.well-known/ai-plugin.json`. A
  file that is served and is not a valid JSON object is reported. A 404, an HTML page or a 5xx
  means no file, and no file is fine: they are optional. No other path is requested.
- **Your phone number or address is in structured data but not written on the page**
  (`quotable-facts-in-data-only`). The page's LocalBusiness structured data has a phone number or
  street address that appears in no visible text, as sent without JavaScript, on the checked page or
  the other pages Gaugeline sampled. Facts you declared in `gaugeline.facts.json` are still checked
  by `facts-present` and `facts-match`.

## Example

Larkspur Family Law is an invented family law practice. Its site went live with the `robots.txt`
from the staging site, a blanket `Disallow: /`, and the owner wants assistants that search the web
to be able to find it (`"aiCrawlers": "search-only"`). Its llms.txt has a title and a summary but
no links, a leftover `agent.json` is cut off, and the phone number and address are only in the
page's markup. Version 0.1.0 prints:

<!-- fixture: ai-agents -->

```sh title=Terminal
$ npx gaugeline larkspur.test
```

```text title=Output
✗ Your robots.txt tells every search engine to stay away
    https://larkspur.test/robots.txt has User-agent: * with Disallow: /
! Your robots.txt does not do what you said you want for AI crawlers
    gaugeline.ai.json says to allow only crawlers that build a search index; for /, blocked but should be allowed: OAI-SearchBot (OpenAI), Claude-SearchBot (Anthropic), PerplexityBot (Perplexity), Amazonbot (Amazon) (4 by the rule for every crawler)
· Your llms.txt is not in the format assistants expect
    https://larkspur.test/llms.txt: no ## sections
· Your phone number or address is in structured data but not written on the page
    phone and street address in structured data, not found as text on 1 page read
· An agent discovery file on your site is broken
    .well-known/agent.json (A2A agent card (earlier path)) is not valid JSON
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

5 to look at, 1 to fix first.
```

The first finding is the older `robots-block` check (the blanket rule, for search engines too). Each check that passed also prints a `✓ <id>` line, left out above. The output is asserted by
`pnpm docs:examples` in CI.

## If you find one

- **Blocked by the blanket rule**: remove the `Disallow: /` from robots.txt, or add a group for each
  crawler you want, such as `User-agent: OAI-SearchBot` followed by `Allow: /`. A crawler with its own
  group ignores the rule for every crawler.
- **llms.txt**: start with one `#` line naming the business, an optional `>` summary, then `##`
  sections of `- [Page](https://...): what it is` lines. The format is the
  [llmstxt.org](https://llmstxt.org/) proposal. Long text belongs in `llms-full.txt`, which
  Gaugeline does not read.
- **A discovery file**: fix the JSON or delete the file.
- **Facts**: put the number and address in the footer as text.

## Signals on the page itself, and llms.txt

`robots.txt` is one place to say what you want from AI crawlers. A page can say it too: an `X-Robots-Tag` header
(often set by a CDN rule or a framework config that nobody remembers) and a meta tag in the template. With an
`aiCrawlers` intent in `gaugeline.ai.json`, `ai-crawlers-directives` compares those signals with it, as
`ai-crawlers-intent` does for robots.txt:

- `noai` or `noimageai`, in the header or in a robots meta tag, asks training crawlers to stay away. It counts
  against `allow`, because you want them in. It agrees with `training-block`, `search-only` and `block`.
- `noindex` or `none` for one crawler, in the header (`X-Robots-Tag: GPTBot: noindex`) or in a meta tag named for it
  (`<meta name="GPTBot" content="noindex">`), counts against any intent that wants that crawler allowed.
- A general `noindex` is about every crawler, search engines included: the `noindex` check reports it.
- With the intent `block`, a published `llms.txt` is reported, once per site: it is a guide written for the
  assistants you said to keep out.

A signal that fails to block a crawler you want blocked is not reported here: robots.txt may block it, and
`ai-crawlers-intent` reads that. Without an intent nothing is compared.

Larkspur Family Law wants assistants to read its site, and a header from a CDN rule says `noai, noimageai` on every
page, while a meta tag in the template tells one named crawler `noindex`. robots.txt allows everything, so
`ai-crawlers-intent` finds nothing.

<!-- fixture: ai-directives -->

```sh title=Terminal
$ npx gaugeline larkspur-family-law.example
```

```text title=Output
! Your page signals to AI crawlers differ from what you said you want
    gaugeline.ai.json says to allow every AI crawler; for /, the X-Robots-Tag header says noai and noimageai for GPTBot (OpenAI), ClaudeBot (Anthropic), Google-Extended (Google), Applebot-Extended (Apple) and 2 more and the ClaudeBot meta tag says noindex for ClaudeBot (Anthropic)
? 4 checks could not run: email-spf-missing, email-spf-multiple, email-dmarc-missing, email-dmarc-none
    Mail records are read from DNS only with --dns. Rerun with --dns to check them.

1 to look at, none to fix first.
```

The finding names the place (the header or the tag), the directive and the crawlers it keeps away, and never any page
text: only directives from a fixed list are read. `noai`, `noimageai` and the `Crawler: directive` form for AI
crawlers are conventions, not part of a standard Gaugeline could read from an official page: the check's technical
line in the [checks reference](/docs/checks) says they are from memory.

## What it requests

`/robots.txt` and `/llms.txt` once each, the four `/.well-known/` paths above once each, and the
other pages Gaugeline already samples for structured data. See
[Security](../security.md#how-much-a-run-requests).

## What could not be confirmed

The vendor pages and specifications for the crawlers, llms.txt and the `.well-known` files could not
be reached when this was written. The crawler list is unchanged from the earlier, sourced list, and
the four `.well-known` paths are marked `uncited` in
[`well-known.json`](https://github.com/alvinwquach/gaugeline/blob/main/packages/core/src/data/well-known.json)
until someone confirms them against their specifications. The llms.txt rules above (a `#` title is
required, the rest is optional) follow the llmstxt.org proposal as the author remembered it and are also
`uncited`.

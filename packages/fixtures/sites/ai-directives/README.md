# ai-directives

An invented family law practice (Larkspur Family Law) that wants AI assistants to read its site
(`gaugeline.ai.json`: `"aiCrawlers": "allow"`), for `ai-crawlers-directives` (AI-14). Nothing here is a real business.

- `/` is sent with `X-Robots-Tag: noai, noimageai` (a CDN rule nobody remembers) and has a meta tag that tells one named
  crawler `noindex`: the finding. robots.txt allows everything, so `ai-crawlers-intent` finds nothing.
- `ai-directives-block` wants no AI crawler (`"aiCrawlers": "block"`), robots.txt blocks each, and the site still publishes
  `llms.txt`: the finding about the file.
- `ai-directives-clean` says `allow` and sends no signal: no finding.

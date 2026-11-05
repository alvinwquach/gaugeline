# Introduction

Gaugeline checks the real page before your visitors do. This is everything it does today, and what's coming next.

Websites built with a headless CMS like Sanity keep content in one place and the website in another. The editor checks each field, but it can't see the finished page. Most real mistakes live in that gap: a price that disagrees with checkout, a link to something nobody published, a page Google can't read.

<!-- diagram: seam (drawn on the landing page; not reproduced here) -->

- **If you own the site:** You don't need to understand any of this. Run one check and you get a plain list of what's wrong and what it costs you.
- **If you run marketing:** Most of what breaks here is invisible in analytics until traffic or leads drop. This catches it at the source.
- **If you edit content:** Nothing here changes your work. It checks the page your words landed on.
- **If you build the site:** Every check is a plain rule with evidence attached, and an exit code for CI.

## What's available today

The site check: one command that reads any live page the way a search engine does and writes a plain-English report. It's free, open source, and works on any website, not just Sanity sites.

```sh title=Terminal
$ npx gaugeline yoursite.com
```

### What it looks for, by area

<!-- chart: areas -->

_Every check in the reference, grouped by what it protects._

## What's coming

- The Sanity plugin, which holds a publish until the page is right. Coming in version 0.2.
- A Playwright helper that tests every page with your real content.
- An MCP server, so AI assistants can check a change before making it. They can plan a fix but never approve their own.

::: info
New to headless websites? Read [How it works](/docs/how-it-works) first. It takes two minutes.
:::

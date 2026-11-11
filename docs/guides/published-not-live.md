# Published but not live: the menu the owner changed that the site never showed

The most common message a freelancer gets about a headless site is "I published it and the site didn't change".
Usually a revalidation webhook failed, or the page is cached for a year, and nobody knows until the client
rings. `--published` asks your content system what changed in the last few days, opens the live page of each
changed item, and tells you which pages still show something else, which published items have no page, and
which pages still serve after the item was unpublished.

It only looks. Every request is a `GET` of a page on the site you are checking, through the same fetcher as
every other check. Nothing is submitted, nothing is revalidated, and no page is purged: Gaugeline tells you
what is stale and leaves the fixing to you.

```sh
npx gaugeline lantern-ladle.example --published
```

## What it finds

| Finding                  | Level  | When                                                                                                                          |
| ------------------------ | ------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `published-not-live`     | high   | A configured field of an item changed more than the grace period ago (15 minutes) and the live page does not show it          |
| `live-page-missing`      | high   | A published item changed more than the grace period ago and its address answers 404 or 410                                    |
| `unpublished-still-live` | medium | A page in the site's sitemap fits an item address pattern, no published item has that address, and the page still answers 200 |

A page is allowed to lag its item for the grace period, so a menu saved a minute ago and not rebuilt yet is
not a finding. Exactly 15 minutes is still inside the grace period; 16 is not.

## What it reads

| It reads                 | How                                                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| The items changed lately | `published()` of each adapter in `gaugeline.adapters.json` (Sanity, WordPress, Webflow and the others), or the site's sitemap when there is no file |
| The page of each item    | One `GET` of the item's address (the adapter's own, or the `urls` template of its type), on the site being checked only, newest change first        |
| What the page shows      | Its `title`, the parts of the title around a site name, `og:title` and the headings                                                                 |
| What the cache says      | The page's `Age`, `Last-Modified`, `Cache-Control`, `X-Vercel-Cache`, `X-Nextjs-Cache` and `CF-Cache-Status` headers                                |

The comparison uses fingerprints, not text. The adapter hashes the configured field of each item (the `title`
unless you say otherwise) and Gaugeline hashes what the page shows the same way. A page that shows the title in
capitals, with an ampersand written as an entity, with typographic quotes, or followed by the site name, is the
same title. A finding names the field that differs and never shows the client's words, from the content system or
from the page.

Items without an address on the site (a type with no `urls` template, or an address on another host) are not
asked for, and the run says how many. At most 40 pages are asked for in one run.

## Settings

All optional, in `gaugeline.adapters.json`, beside the adapters:

```json
{
  "adapters": [{ "id": "sanity", "urls": { "menu": "/menu/{slug}" } }],
  "live": { "days": 7, "graceMinutes": 15, "maxPages": 40, "fields": { "menu": ["title"] } }
}
```

| Setting        | Default | Meaning                                                                |
| -------------- | ------- | ---------------------------------------------------------------------- |
| `days`         | 7       | Items changed in the last this many days are compared with their pages |
| `graceMinutes` | 15      | How long a page may lag its item before it is reported                 |
| `maxPages`     | 40      | The most pages asked for in one run                                    |
| `fields`       | `title` | The fields to compare with the page, by type                           |

`gaugeline run --all --published` adds it to every site of a nightly run.

## What it cannot see

Where Gaugeline cannot tell, it says so under could-not-check, never as a pass:

- A content system that would not answer (a key that may not read it, a rate limit that stayed): the reason is
  listed and the items read before it are kept.
- A page that answered something other than 200, 404 or 410, or redirected to another site.
- Pages of unpublished items need a list of the whole site (the sitemap) and an adapter with `urls` templates.
  A sitemap that is itself stale will not list a page that should be there, and a list of everything published
  that is cut short means this is not looked for.
- A field shown in capitals whose original has capitals inside words (`iPhone Case`) cannot be matched back to
  the original, and is reported as differing.
- Webhook delivery history (Sanity's webhook attempts, for example) is not read yet: the finding tells you the
  page is stale, and where to look next, not which delivery failed.

## Example: a bar that published its autumn menu

Lantern & Ladle is an invented client: a bar whose owner edits the menu in Sanity. On Friday at ten to eleven
she publishes the autumn cocktail menu and tells her regulars on Instagram. At noon a regular messages that the
site still shows the summer one. The freelancer has a nightly run, and this is what it would have said an hour
after she published:

```json title="gaugeline.adapters.json"
{
  "adapters": [{ "id": "sanity", "urls": { "menu": "/menu/{slug}" } }]
}
```

```sh
npx gaugeline lantern-ladle.example --published
```

The page `/menu/autumn-cocktails` was fetched, and its title is still the summer one. The finding, as the run
reports it:

```text title="Finding: published-not-live (high)"
menu autumn-cocktails was saved 2026-11-11T10:58:00.000Z (62 minutes ago; grace 15 minutes). The page differs in: title. Page headers: age 3540, cache-control s-maxage=31536000, x-vercel-cache HIT
```

Read it from left to right. The content system says the menu was saved 62 minutes ago. The page's `Age` is
3,540 seconds, which is 59 minutes: the copy was made a few minutes after the save, before the change reached
it. `Cache-Control` says the page may be kept for a year and Vercel served it from its cache (`HIT`). So the
page was not rebuilt after the save: look at the revalidation webhook the CMS calls on publish, the path or tag
it revalidates, and whether the site answered it with a 2xx. Then republish the menu or purge the page, and run
`--published` again.

## Checks

- `published-not-live`, `live-page-missing` and `unpublished-still-live` are listed with what they catch, why they
  matter and how to fix them in the [checks reference](../checks.md).
- Settings: the `live` entry of `gaugeline.adapters.json`. Adapters: [Integrations](../integrations/index.md).
- What it sends: [Privacy and safety](../privacy.md#published-but-not-live-published).

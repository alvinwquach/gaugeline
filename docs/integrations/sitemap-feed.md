# Sitemap and feeds: content checks for sites built on any CMS

What a site says is published, read from the files nearly every CMS already publishes. No key, no account, nothing to install on the client's side.

Most content systems, Squarespace, Shopify, Joomla, Duda, Tilda, GoDaddy, Drupal, Ghost and the long tail of the rest, have no adapter of their own, but nearly all of them publish a `sitemap.xml` and an RSS, Atom or JSON feed. This adapter reads those files and gives the same fingerprints a native adapter gives: an address, when it was published, when it changed, and which group it belongs to. It never reads a title, a description or a word of the client's content.

It is the default content adapter. With no `gaugeline.adapters.json`, a run that is given a site address and needs "what is published" (the published-but-not-live check, F-05, and the checks after it) reads the site's sitemap and feeds. A settings file that names another adapter, such as Sanity, replaces the default. Nothing on the command line reads it by itself yet; those checks use it as they arrive. See [Content systems](/docs/integrations/) for the interface every adapter shares.

## The key

None. The adapter asks for no key, sends no `Authorization` header and no cookie, and never logs in. It only reads the files the site hands every visitor. A run says so before anything else it prints about the content system:

```text title=Output
Content system: Sitemap and feeds, with no key (it only reads pages the site already publishes). How it reads them: https://gaugeline.dev/docs/integrations/sitemap-feed
```

## What it reads

Every request is a `GET`, through the same fetcher as every other request, which refuses private, loopback, link-local and metadata addresses.

- `GET /robots.txt`, for its `Sitemap:` lines.
- The sitemaps named there; with none, `GET /sitemap.xml`, then `/sitemap_index.xml` and `/wp-sitemap.xml`, stopping at the first that reads. A sitemap index is followed to each of its children, whatever the nesting, and each file once.
- The feeds the home page advertises (`link rel="alternate"` with an RSS, Atom or JSON Feed type; comment feeds are skipped); with none advertised, `/feed`, `/feed.xml`, `/rss.xml`, `/atom.xml` and `/feed.json`.
- gzip sitemaps (`sitemap.xml.gz`), unpacked under a size cap.

From each file it keeps only the address and the dates. From a sitemap: `loc`, `lastmod`, and a news sitemap's `publication_date`. From RSS: `link` (or a `guid` that is an address), `pubDate` or `dc:date`, and the first `category`. From Atom: the `alternate` link, `published`, `updated` and the first category. From JSON Feed: `url` (or an `id` that is an address), `date_published`, `date_modified` and the first tag. Titles, descriptions and content are never read, so none can reach a report.

These formats are defined by the [Sitemaps protocol](https://www.sitemaps.org/protocol.html), the [RSS 2.0 specification](https://www.rssboard.org/rss-specification), [RFC 4287](https://www.rfc-editor.org/rfc/rfc4287) (Atom) and [JSON Feed 1.1](https://www.jsonfeed.org/version/1.1/). Those pages could not be reached when this was written (the build session's network policy refused them), so the field names and limits above are the ones Gaugeline's own tests pin, from the specifications as the build knew them. Check them against the current pages before relying on a detail.

## Example: a bakery on Squarespace

Oakline Bakery is an invented neighbourhood bakery. A freelancer built its site on Squarespace: a blog with a feed, a small shop and a few pages. The owner writes posts from her phone. The freelancer has no Sanity project and no WordPress to log in to, and wants to know which pages changed lately.

Settings go in `gaugeline.adapters.json` in the project folder. The `site` line is only needed when the run is not given the address:

```json title=gaugeline.adapters.json
{
  "adapters": [
    {
      "id": "sitemap-feed",
      "site": "https://oakline-bakery.example"
    }
  ]
}
```

Oakline's `robots.txt` names a sitemap index with three children (pages, the blog as a gzip file, the shop). Its blog feed has a post with no date and a recipe that is in the feed and not in the sitemap. This is what the adapter reads over it (invented), for pages changed since 1 November:

```json title=Output
{
  "types": [
    {
      "name": "blog",
      "count": 3
    },
    {
      "name": "recipes",
      "count": 1
    },
    {
      "name": "shop",
      "count": 2
    },
    {
      "name": "top-level",
      "count": 3
    }
  ],
  "field counts": "could not check: Not applicable: a sitemap or a feed lists addresses and dates, not fields, so there is nothing to count. Field counts need a native adapter for the content system.",
  "drafts reachable": "not-applicable",
  "changed since 1 November": [
    {
      "id": "https://oakline-bakery.example/menu",
      "type": "top-level",
      "url": "https://oakline-bakery.example/menu",
      "slug": "menu",
      "updatedAt": "2026-11-05T08:30:00.000Z",
      "fieldHashes": {}
    },
    {
      "id": "https://oakline-bakery.example/blog/pop-up-saturday",
      "type": "blog",
      "url": "https://oakline-bakery.example/blog/pop-up-saturday",
      "slug": "pop-up-saturday",
      "fieldHashes": {}
    },
    {
      "id": "https://oakline-bakery.example/rye-recipe",
      "type": "recipes",
      "url": "https://oakline-bakery.example/rye-recipe",
      "slug": "rye-recipe",
      "publishedAt": "2026-11-06T07:30:00.000Z",
      "fieldHashes": {}
    }
  ]
}
```

Read it the way the freelancer does:

- The menu page changed on 5 November. Its `lastmod` said `2026-11-05T09:30:00+01:00`, which is `08:30` UTC; every time is shown in UTC.
- The rye recipe is in the feed and not in the sitemap. It is listed from the feed alone, with the date the feed gives. A recipe the sitemap forgot is still a page that should be live.
- The "Pop-up Saturday" post has no date anywhere: no `lastmod`, no `pubDate`. It is listed with no date at all, never one made up, and `since` keeps it because nothing says it is old. A check that needs a date says so for that page.
- The spring loaf post (a `lastmod` of 1 March) and the winter hours post (a `lastmod` of 2 October) are left out, because their dates are older. Had the feed said the spring loaf post was updated in October, the newer date would have won: a stale `lastmod` gives way to a later date in a feed, and an older date in a feed never lowers a `lastmod`.
- Field counts and drafts are not applicable. See below.

Nothing of the posts' titles or text is in the output, though the feed carries them.

## What a type means here

A sitemap has no content types, so a type is a group Gaugeline makes from the address, and it is only as good as the site's address layout:

1. The first folder of the address, lower case, when there is one: `/blog/spring-loaf` is `blog`, `/shop/sourdough-box` is `shop`.
2. For an address with no folder (`/rye-recipe`), the first category the feed gives it: `Recipes & Bakes` is `recipes-bakes`.
3. Otherwise `top-level`: the home page and single-segment pages such as `/about`.

A folder always wins over a category. A site with a language prefix (`/en/about`) groups by language, not by kind of content, and a blog that lives at the top level with no categories is all `top-level`. Types are sorted by name. `published()` filters by the same names, so `types: ["blog"]` is the blog's items.

An item's `id` and `url` are the same address (as listed, with any fragment dropped), and its `slug` is the last part of the path. A sitemap entry and a feed item for the same page are one item, whatever the trailing slash, `http` or `https`, or `www`.

## Dates

`updatedAt` is the newest of the sitemap's `lastmod` and the feed's `updated`; `publishedAt` is the feed's publish date or a news sitemap's publication date. Either is left out when no file gives one, and a date that is not a date counts as none.

A date and time with no zone is read as UTC, so the same file gives the same answer on every machine. `since` compares with the newest date an item has, and keeps an item with no date at all.

A site whose `lastmod` is the same on every page (a generator that stamps the build time) gives dates that are true and useless. The adapter reports them as written; a check that compares them should say so.

## What needs a native adapter instead

A sitemap and a feed say what the site chose to publish, and nothing more. These questions need the content system's own API. This adapter answers them as could-not-check with the reason, or leaves them empty, and never as a pass:

| Question                                         | Answer here                            | Why                                                                                |
| ------------------------------------------------ | -------------------------------------- | ---------------------------------------------------------------------------------- |
| How many items have each field (`fieldCounts`)   | could not check, "Not applicable"      | There are no fields in a sitemap or a feed.                                        |
| A hash of a field's value (`fieldHashes`)        | always empty                           | There is nothing to hash. The settings' `fingerprint` is refused for this adapter. |
| Are drafts reachable (`draftsReachable`)         | `not-applicable`, with no request made | A sitemap never lists a draft, so it cannot say whether the CMS has any.           |
| Who has access to the content system (`members`) | not offered                            | No public file lists people.                                                       |
| Items staged but not published                   | not visible                            | The files list only what is published.                                             |
| A page the site publishes but leaves out         | not visible                            | The sitemap and feeds are the list. An item in neither is not known here.          |

What it does answer, for any CMS: which addresses the site says are published, and when they changed. That is what published-but-not-live, orphaned pages and migration completeness need.

## When it cannot check

It never returns a list with a hole in it. The read is could-not-check, with the reason in plain words, when:

- no sitemap and no feed could be read (it names where it looked), or the site answers with a login (HTTP 401 or 403);
- a file that `robots.txt`, an index or your settings name answers "not found", fails, or is not a sitemap or a feed;
- a file is larger than the cap once unpacked (a decompression bomb is refused, not read);
- the files name more files or addresses than the caps below;
- the run has no site address.

A file that was only guessed at (`/sitemap.xml` with no `robots.txt`, a usual feed path) may simply be missing; that is not an error as long as something else could be read. A site that asks Gaugeline to slow down (HTTP 429) is waited for once when it says how long and the wait is a minute or less; after that the run keeps what it had read and says it is partial.

## What is bounded

| Limit                                   | Value  |
| --------------------------------------- | ------ |
| Sitemap files read (index and children) | 50     |
| Feeds read                              | 5      |
| Addresses in all the files together     | 50,000 |
| One file, after gzip is unpacked        | 5 MB   |

There are no flags to raise them. They are a promise to the site being read, like the limits on the [running a check](/docs/running-a-check) page.

A sitemap index may not send Gaugeline to another site. Only sitemaps and children on the checked site (`www` counts as the same site) are read, as the Sitemaps protocol keeps a sitemap to its own site. A `Sitemap:` line or an index child on another host is not requested, and neither is an entry that is not an `http` or `https` address on the site. An index that lists itself, or two that list each other, are each read once. The XML is parsed without expanding entities, so an entity bomb or an external entity (`file:///...`) is read as the plain text it is and no file is read. Everything fetched is data: nothing in a sitemap or a feed is ever run or followed as an instruction.

## Settings

| `gaugeline.adapters.json` field | What it does                                                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapters[].id`                 | `sitemap-feed`.                                                                                                                                    |
| `adapters[].site`               | The site's address (`https://oakline-bakery.example`). Wins over the address the run was given.                                                    |
| `adapters[].sitemaps`           | Up to 10 sitemap files to read instead of looking: a path on the site or an https address on it. Each must answer, or the read is could-not-check. |
| `adapters[].feeds`              | Up to 5 feeds to read instead of looking, likewise.                                                                                                |

`fingerprint` and `urls` are refused for this adapter: it has no fields to hash, and an item is its own address.

# Framer: content checks for sites built on Framer (beta)

What a Framer site publishes, read from the files the live site hands every visitor. No key, and nothing is written. Framer's CMS collections themselves are could-not-check, and this page says why.

**The key first.** Framer has no read-only key. Its one kind of key is a project API key (project settings, API Keys), and it opens the Framer Server API, which is the same interface a Framer plugin uses inside the editor. With it a program can read the project, and it can also add and remove collection items, change pages and set custom code. Gaugeline does not ask for it, does not read it and will not use it: the Server API is not a request Gaugeline is allowed to send (see below). If `FRAMER_API_KEY`, the variable the Server API's own package reads, is set where Gaugeline runs, Gaugeline ignores it, and it never reaches a request, a message or a report. Gaugeline's key kind for Framer is `read-only` with no key at all, because nothing it does can change anything.

**This adapter is beta.** Framer's Server API is a beta, and a run says so before anything else it prints about the content system:

```text title=Output
Content system: Framer (beta), with no key (it only reads pages the site already publishes). How it reads them: https://gaugeline.dev/docs/integrations/framer
```

See [Content systems](/docs/integrations/) for the interface every adapter shares.

## What the Server API is, and why Gaugeline does not use it

**A note on sources.** Framer's own documentation could not be reached when this page was written (the build session's network policy refused `www.framer.com`), so nothing below is confirmed against Framer's pages. What it rests on is the published `framer-api` package (version 5.1.0, MIT licensed, on the npm registry): its README, which links Framer's Server API pages, and its type definitions. Check this page against Framer's current [Server API introduction](https://www.framer.com/developers/server-api-introduction) and [reference](https://www.framer.com/developers/server-api-reference) before relying on a detail. [docs]

What the package shows:

- It is a library, not a web address you can request. `connect(projectUrl, apiKey)` opens a WebSocket to `wss://api.framer.com/channel/headless-plugin` and speaks the Plugin API over it. There is no documented HTTP endpoint that answers a `GET` or a `HEAD` with a collection's items.
- The key comes from the project's settings ("API Keys") or from `FRAMER_API_KEY`. The package offers one kind of key and no way to narrow it, so there is no read-only key to ask for.
- The same connection that reads collections (`getCollections()`, a collection's `getItems()` and `getFields()`, `getPublishInfo()`) can also change them (`addItems()`, `removeItems()`, `setAttributes()`, `createCollection()`, `setCustomCode()`).

Gaugeline sends `GET` and `HEAD` requests through its fetcher and nothing else, and its fetcher is the one place that refuses private and metadata addresses. A WebSocket session with a key that can change the project is neither. So the CMS collections are **could not check**, with the reason, and Gaugeline does not work around it: it does not scrape the Framer editor, does not use the project API key from a second tool, and does not guess a collection's contents from the page. If Framer adds a read-only key or an HTTP endpoint that lists collection items, this adapter gains the read, and this page changes with it. That is open question 51 for the owner.

## What it reads

Every request is a `GET`, to the checked site and nowhere else, through the same fetcher as every other request. Framer's own servers are never asked.

- `GET /robots.txt`, for its `Sitemap:` lines.
- The sitemaps named there; with none, `GET /sitemap.xml`, then `/sitemap_index.xml` and `/wp-sitemap.xml`, stopping at the first that reads. A Framer site generates its sitemap at `/sitemap.xml` (uncited: Framer's pages could not be reached, so this is the usual place and not a confirmed one; a site that names another in `robots.txt` or in the settings is read from there).
- The feeds the home page advertises; with none advertised, `/feed`, `/feed.xml`, `/rss.xml`, `/atom.xml` and `/feed.json`. A Framer site has no feed unless you add one.

It reads the sitemap the way the [Sitemap and feeds](/docs/integrations/sitemap-feed) adapter does (that page has the limits, the dates and the safety rules, and they are the same here): only an address and its dates are kept, a title or a word of the client's text never is, and a sitemap that is missing, refused or unreadable is could-not-check, never an empty list. It never asks for a page of the site: whether an address in the sitemap still answers is the job of the sitemap checks, not of an adapter.

## Example: a ceramics pop-up on Framer

Lantern Row is an invented ceramics pop-up. A freelancer built its site on Framer: a few pages (home, about, visit), a journal collection and a drops collection, one page for each item. The owner adds a new drop from her phone the morning of each market, and the freelancer wants to know which pages the site says changed lately.

Settings go in `gaugeline.adapters.json` in the project folder. The `site` line is only needed when the run is not given the address. There is nothing to put in the environment:

```json title=gaugeline.adapters.json
{
  "adapters": [
    {
      "id": "framer",
      "site": "https://lantern-row.example"
    }
  ]
}
```

This is what the adapter reads over her site (invented), for pages changed since 1 November:

```json title=Output
{
  "types": [
    {
      "name": "drops",
      "count": 2
    },
    {
      "name": "journal",
      "count": 2
    },
    {
      "name": "top-level",
      "count": 3
    }
  ],
  "field counts": "could not check: Not applicable to what Gaugeline can read from a Framer site. Framer's CMS collections can be read only through the Framer Server API, which is a library that talks to Framer over a WebSocket with a project API key that can also change the project. Gaugeline sends only GET and HEAD requests, through its fetcher, so it does not use it and does not ask for the key. What the live site publishes is read from its sitemap instead.",
  "drafts reachable": "not-applicable",
  "changed since 1 November": [
    {
      "id": "https://lantern-row.example/",
      "type": "top-level",
      "url": "https://lantern-row.example/",
      "updatedAt": "2026-11-02T00:00:00.000Z",
      "fieldHashes": {}
    },
    {
      "id": "https://lantern-row.example/visit",
      "type": "top-level",
      "url": "https://lantern-row.example/visit",
      "slug": "visit",
      "updatedAt": "2026-11-08T00:00:00.000Z",
      "fieldHashes": {}
    },
    {
      "id": "https://lantern-row.example/journal/glaze-notes",
      "type": "journal",
      "url": "https://lantern-row.example/journal/glaze-notes",
      "slug": "glaze-notes",
      "updatedAt": "2026-11-06T00:00:00.000Z",
      "fieldHashes": {}
    },
    {
      "id": "https://lantern-row.example/drops/moonglaze-mugs",
      "type": "drops",
      "url": "https://lantern-row.example/drops/moonglaze-mugs",
      "slug": "moonglaze-mugs",
      "updatedAt": "2026-11-09T00:00:00.000Z",
      "fieldHashes": {}
    }
  ]
}
```

Read it the way the freelancer does:

- The Moonglaze mug drop changed on 9 November, the morning of the market. It is on the site's sitemap, so the site says it is published. Whether the CMS agrees (an item staged and not published, an item with no page) is exactly what this adapter cannot see: Framer keeps that in the project.
- The Ember bowls drop (28 October) and the kiln firing post (19 October) are left out: their dates are older. Their addresses are in the `drops` and `journal` counts all the same.
- Field counts are could-not-check, with the reason, and every `fieldHashes` is empty. The page's titles and prices are in the pages and never in the output.
- Drafts are `not-applicable`: the sitemap lists only what is published. Changes saved in the Framer project and not yet published are not visible from the site, and Gaugeline does not look.

## What a type means here

A sitemap has no content types, so a type is a group Gaugeline makes from the address, the same way the Sitemap and feeds adapter does: the first folder of the address, lower case (`/journal/glaze-notes` is `journal`), otherwise `top-level` for the home page and single-segment pages such as `/visit`.

A Framer CMS page lives under its collection's path, so for most sites a type is a collection. Gaugeline cannot tell a collection from a folder of ordinary pages, and a site with a language prefix (`/en/visit`) groups by language. Types are sorted by name, and `published()` filters by the same names.

## What it cannot check

| Question                                       | Answer here                            | Why                                                                                       |
| ---------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| The CMS collections, their items and fields    | could not check, "Not applicable"      | Only the Server API reads them: a WebSocket library, with a key that can change the site. |
| How many items have each field (`fieldCounts`) | could not check, "Not applicable"      | Same reason. Asked for nothing.                                                           |
| A hash of a field's value (`fieldHashes`)      | always empty                           | There is no field to hash. The settings' `fingerprint` is refused for this adapter.       |
| CMS items against live pages                   | not checked                            | It needs the CMS side. The sitemap checks cover the live side (below).                    |
| Are drafts reachable (`draftsReachable`)       | `not-applicable`, with no request made | Unpublished changes live in the Framer project, not on the site.                          |
| Who has access to the project (`members`)      | not offered                            | No public file lists people.                                                              |

What it does answer: which addresses the live site says are published, and when they changed. The checks that read the sitemap against the pages (`sitemap-dead`, `sitemap-redirects`, `sitemap-host`) work on a Framer site as they do on any other, and are what stand in for "CMS items against live pages" until the CMS can be read.

## When it cannot check

It never returns a list with a hole in it. The read is could-not-check, with the reason in plain words, when no sitemap and no feed could be read (it names where it looked), the site answers with a login (HTTP 401 or 403), a sitemap that `robots.txt` or your settings name is missing or is not a sitemap, a file is larger than the cap, or the run has no site address. A site that asks Gaugeline to slow down (HTTP 429) is waited for once when it says how long and the wait is a minute or less; after that the run keeps what it had read and says it is partial.

## Settings

| `gaugeline.adapters.json` field | What it does                                                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapters[].id`                 | `framer`.                                                                                                                                          |
| `adapters[].site`               | The site's address (`https://lantern-row.example`). Wins over the address the run was given.                                                       |
| `adapters[].sitemaps`           | Up to 10 sitemap files to read instead of looking: a path on the site or an https address on it. Each must answer, or the read is could-not-check. |
| `adapters[].feeds`              | Up to 5 feeds to read instead of looking, likewise.                                                                                                |

`fingerprint` and `urls` are refused for this adapter: it has no fields to hash, and an item is its own address.

# Wix: content checks for sites built on Wix

What a Wix site publishes, read from the files the live site hands every visitor. No key, and nothing is written. The items of a Wix CMS collection are could-not-check, and this page says why.

**The key first.** Wix has a key that can be limited to reading: an API key with only read permissions selected (you pick a key's permissions one by one, and here only those that read Wix Data). That is the narrowest key Wix offers, and it is the one this adapter will ask for once it reads the CMS. It is not used in this version. The call that lists a collection's items is `POST /wix-data/v2/items/query`, and Gaugeline sends `GET` and `HEAD` and nothing else. So Gaugeline asks for no key, does not read one, and a Wix API key that happens to be set where it runs never reaches a request, a message or a report. Its key kind for Wix is `read-only` with no key at all, because nothing it does can change anything. The owner has decided that a documented read-only `POST` query is allowed through a per-adapter allowlist (ADR-0006), so the CMS read is coming as a follow-up (C-05b; open question 52, below).

A run says what it uses before anything else it prints about the content system:

```text title=Output
Content system: Wix, with no key (it only reads pages the site already publishes). How it reads them: https://gaugeline.dev/docs/integrations/wix
```

See [Content systems](/docs/integrations/) for the interface every adapter shares.

## What Wix reads with, and why Gaugeline does not use it

**A note on sources.** Wix's developer documentation could not be reached when this page was written (the build session's network policy refused `dev.wix.com`), so nothing below is confirmed against Wix's pages. The endpoint shapes are from memory of the Wix REST reference, and each is marked uncited. Check them against the current [Data Items reference](https://dev.wix.com/docs/rest/business-solutions/cms/data-items/items/introduction) and [Data Collections reference](https://dev.wix.com/docs/rest/business-solutions/cms/data-collections/collections/introduction) before relying on a detail. [docs]

What the reference describes (uncited, from memory):

| Endpoint (base `https://www.wixapis.com`) | Method | What it does                                           | Can Gaugeline send it?          |
| ----------------------------------------- | ------ | ------------------------------------------------------ | ------------------------------- |
| `/wix-data/v2/items/query`                | `POST` | Lists a collection's items; the filter is in the body. | No: not `GET` or `HEAD`.        |
| `/wix-data/v2/items/count`                | `POST` | Counts a collection's items.                           | No: same reason.                |
| `/wix-data/v2/items/{dataItemId}`         | `GET`  | Reads one item, given its id and its collection's id.  | Yes, but nothing lists the ids. |
| `/wix-data/v2/collections`                | `GET`  | Lists the collections: their fields and who may read.  | Yes, but it holds no items.     |

Two things follow. A `GET` for one item needs its id, and the only way Wix lists ids is the `POST` query, so the `GET` cannot be used on its own. And the collections list gives the shape of the CMS (collection names, field names, read permission) and none of its content: it cannot say how many items are published, which have a field, or which are hidden. Gaugeline does not call it, because a list of collections answers none of the questions an adapter is asked.

The key (uncited): an API key is made in the Wix account's API keys manager. You choose the permissions it has, and a key with only the read permissions of Wix Data can read collections and items and cannot change them. It is sent in the `Authorization` header, with the site's id in a `wix-site-id` header for a call about one site.

Gaugeline sends `GET` and `HEAD` requests through its fetcher and nothing else, and its fetcher is the one place that refuses private and metadata addresses. The one exception in the rules is a notification to your own channel. A query that only reads is still a `POST`, so the items are **could not check**, with the reason, and Gaugeline does not work around it: it does not scrape the Wix editor or dashboard, does not send the query "just once", and does not guess a collection's contents from the page. The owner has decided (11 November 2026, open question 52) that read-only `POST` queries to documented query endpoints are allowed under an allowlist per adapter (ADR-0006), so this adapter will gain the read, ask for the read-only API key, and this page will change with it. That is the follow-up branch C-05b; this version sends no `POST`.

## What it reads

Every request is a `GET`, to the checked site and nowhere else, through the same fetcher as every other request. Wix's own servers (`www.wixapis.com`) are never asked.

- `GET /robots.txt`, for its `Sitemap:` lines.
- The sitemaps named there; with none, `GET /sitemap.xml`, then `/sitemap_index.xml` and `/wp-sitemap.xml`, stopping at the first that reads. A Wix site publishes its sitemap at `/sitemap.xml`, an index with one file for the pages and one for each part of the site that Wix generates, such as the blog or a collection's dynamic pages (uncited: Wix's pages could not be reached, so this is the usual layout and not a confirmed one; Gaugeline reads whichever files the index lists, and a site that names another in `robots.txt` or in the settings is read from there).
- The feeds the home page advertises; with none advertised, `/feed`, `/feed.xml`, `/rss.xml`, `/atom.xml` and `/feed.json`. A Wix blog has a feed; a site with no blog has none.

It reads the sitemap the way the [Sitemap and feeds](/docs/integrations/sitemap-feed) adapter does (that page has the limits, the dates and the safety rules, and they are the same here): only an address and its dates are kept, a title or a word of the client's text never is, and a sitemap that is missing, refused or unreadable is could-not-check, never an empty list. If one of the files an index lists is refused, the whole read is could-not-check and names the file; a list with a hole in it would make every "not in the list" answer wrong. It never asks for a page of the site: whether an address in the sitemap still answers is the job of the sitemap checks, not of an adapter.

## Example: a career coach on Wix

Marlow Coaching is an invented one-person career-coaching practice. A freelancer built its site on Wix: a few pages (home, about, book a call), a blog, and a programs collection with one dynamic page for each program. The coach opens her Spring cohort for sign-ups from her phone the morning she sends her newsletter, and the freelancer wants to know which pages the site says changed lately.

Settings go in `gaugeline.adapters.json` in the project folder. The `site` line is only needed when the run is not given the address. There is nothing to put in the environment:

```json title=gaugeline.adapters.json
{
  "adapters": [
    {
      "id": "wix",
      "site": "https://marlow-coaching.example"
    }
  ]
}
```

This is what the adapter reads over her site (invented), for pages changed since 1 November:

```json title=Output
{
  "types": [
    {
      "name": "post",
      "count": 3
    },
    {
      "name": "programs",
      "count": 2
    },
    {
      "name": "top-level",
      "count": 3
    }
  ],
  "field counts": "could not check: Not applicable to what Gaugeline can read from a Wix site. Wix lists the items of a CMS collection only with Query Data Items, which is a POST request, and counts them with Count Data Items, also a POST. Gaugeline sends only GET and HEAD requests, through its fetcher, so it does not send them and does not ask for a Wix API key. What the live site publishes is read from its sitemap instead.",
  "drafts reachable": "not-applicable",
  "changed since 1 November": [
    {
      "id": "https://marlow-coaching.example/",
      "type": "top-level",
      "url": "https://marlow-coaching.example/",
      "updatedAt": "2026-11-02T00:00:00.000Z",
      "fieldHashes": {}
    },
    {
      "id": "https://marlow-coaching.example/book-a-call",
      "type": "top-level",
      "url": "https://marlow-coaching.example/book-a-call",
      "slug": "book-a-call",
      "updatedAt": "2026-11-08T00:00:00.000Z",
      "fieldHashes": {}
    },
    {
      "id": "https://marlow-coaching.example/post/salary-first-call",
      "type": "post",
      "url": "https://marlow-coaching.example/post/salary-first-call",
      "slug": "salary-first-call",
      "updatedAt": "2026-11-06T00:00:00.000Z",
      "fieldHashes": {}
    },
    {
      "id": "https://marlow-coaching.example/programs/spring-cohort",
      "type": "programs",
      "url": "https://marlow-coaching.example/programs/spring-cohort",
      "slug": "spring-cohort",
      "updatedAt": "2026-11-09T00:00:00.000Z",
      "fieldHashes": {}
    }
  ]
}
```

Read it the way the freelancer does:

- The Spring cohort page changed on 9 November, the morning of the newsletter. It is on the site's sitemap, so the site says it is published. Whether the CMS agrees (an item hidden in the CMS that still answers at its address, an item with no page) is exactly what this adapter cannot see: that needs the collection's item list.
- The One to one program (28 October) and the "ninety-day plan" post (19 October) are left out: their dates are older. Their addresses are in the `programs` and `post` counts all the same.
- Field counts are could-not-check, with the reason, and every `fieldHashes` is empty. The page's titles and prices are in the pages and never in the output.
- Drafts are `not-applicable`: the sitemap lists only what is published. Draft items saved in the Wix CMS are not visible from the site, and Gaugeline does not look.

## What a type means here

A sitemap has no content types, so a type is a group Gaugeline makes from the address, the same way the Sitemap and feeds adapter does: the first folder of the address, lower case (`/programs/spring-cohort` is `programs`), otherwise `top-level` for the home page and single-segment pages such as `/about`.

A Wix dynamic page lives under the path its owner set for the collection, so for most sites a type is a collection. Gaugeline cannot tell a collection from a folder of ordinary pages, and a site with a language prefix (`/en/about`) groups by language. Types are sorted by name, and `published()` filters by the same names.

## What it cannot check

| Question                                                          | Answer here                            | Why                                                                                                                 |
| ----------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| The CMS collections' items and fields                             | could not check, "Not applicable"      | Wix lists items only with a `POST` query, and Gaugeline sends `GET` and `HEAD`. Coming in C-05b (open question 52). |
| How many items have each field (`fieldCounts`)                    | could not check, "Not applicable"      | Same reason. Asked for nothing.                                                                                     |
| A hash of a field's value (`fieldHashes`)                         | always empty                           | There is no field to hash. The settings' `fingerprint` is refused for this adapter.                                 |
| Collection items that are hidden but still reachable at their URL | not checked                            | It needs the item list and each item's hidden state, which only the `POST` query gives.                             |
| CMS items against live pages                                      | not checked                            | It needs the CMS side. The sitemap checks cover the live side (below).                                              |
| Are drafts reachable (`draftsReachable`)                          | `not-applicable`, with no request made | Draft items live in the Wix CMS, not on the site.                                                                   |
| Who has access to the site (`members`)                            | not offered                            | No public file lists people.                                                                                        |

What it does answer: which addresses the live site says are published, and when they changed. The checks that read the sitemap against the pages (`sitemap-dead`, `sitemap-redirects`, `sitemap-host`) work on a Wix site as they do on any other, and are what stand in for "CMS items against live pages" until the CMS can be read.

## When it cannot check

It never returns a list with a hole in it. The read is could-not-check, with the reason in plain words, when no sitemap and no feed could be read (it names where it looked), the site answers with a login (HTTP 401 or 403), a sitemap that `robots.txt`, an index or your settings name is missing or is not a sitemap, a file is larger than the cap, or the run has no site address. A site that asks Gaugeline to slow down (HTTP 429) is waited for once when it says how long and the wait is a minute or less; after that the run keeps what it had read and says it is partial.

## Settings

| `gaugeline.adapters.json` field | What it does                                                                                                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapters[].id`                 | `wix`.                                                                                                                                             |
| `adapters[].site`               | The site's address (`https://marlow-coaching.example`). Wins over the address the run was given.                                                   |
| `adapters[].sitemaps`           | Up to 10 sitemap files to read instead of looking: a path on the site or an https address on it. Each must answer, or the read is could-not-check. |
| `adapters[].feeds`              | Up to 5 feeds to read instead of looking, likewise.                                                                                                |

`fingerprint` and `urls` are refused for this adapter: it has no fields to hash, and an item is its own address.

## Open question 52: decided, coming in C-05b

Wix's item list is a `POST` query, which rule 6 did not allow and ADR-0005 does not cover. The owner decided on 11 November 2026 that `POST` is allowed for documented read-only query endpoints (the same rule as a GraphQL query), under an allowlist per adapter of method, path pattern and body shape, with a contract test that no body is a write (ADR-0006). The Wix native read is the follow-up branch C-05b: Query Data Items and Count Data Items through that allowlist, with an API key limited to the Wix Data read permissions. With it, this adapter will count items per collection, hash the fields named in the settings, and run the check for hidden collection items still reachable at their URL. Until then, this page is what Gaugeline does for Wix, and it sends no `POST`.

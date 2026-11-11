# Wix: content checks for sites built on Wix

What a Wix site publishes, read two ways. With **no key**, from the files the live site hands every visitor (its sitemap and feeds), and nothing is written. With **a Wix API key that can only read Wix Data**, from the CMS collections you name, through Wix's Query Data Items endpoint: counts, which fields are filled in, and a fingerprint of each item, never a word of your client's text.

**The key first.** Wix has a key that can be limited to reading: an API key with only read permissions selected (you pick a key's permissions one by one, and here only the one that reads Wix Data items). That is the narrowest key Wix offers, and it is the only one this adapter asks for. It goes in the environment as `WIX_API_KEY`, never in a settings file. The one place Gaugeline sends a `POST` to anything but your own notification channels is this adapter's query: Wix answers "list this collection's items" with a `POST` (the filter travels in the body), and the owner allowed a documented read-only `POST` query through a per-adapter allowlist (ADR-0006, open question 52). Gaugeline sends that one query, to `www.wixapis.com` only, with a body that is a query and never a write, and its fetcher refuses anything else before it is sent. **If your Wix account offers no way to limit a key to reading Wix Data, do not set `WIX_API_KEY`:** the adapter then reads the live site with no key, as it always did.

A run says what it uses before anything else it prints about the content system:

```text title=Output
Content system: Wix, with a read-only key when one is set, and with no key otherwise (it then only reads pages the site already publishes). Endpoints and how to make the key: https://gaugeline.dev/docs/integrations/wix
```

See [Content systems](/docs/integrations/) for the interface every adapter shares.

## What this adapter reads, and the narrowest key

**A note on sources.** Wix's developer documentation could not be reached when this page was written (the build session's network policy refused `dev.wix.com`), so nothing below is confirmed against Wix's pages. The endpoint shapes are from memory of the Wix REST reference, and each is marked uncited; the allowlist entry in the code is marked `checked: null` for the same reason. Check them against the current [Query Data Items reference](https://dev.wix.com/docs/rest/business-solutions/cms/data-items/items/query-data-items) and the [API keys guide](https://dev.wix.com/docs/rest/articles/getting-started/api-keys) before relying on a detail, and before you trust a key's permissions. [docs]

What Gaugeline sends (uncited, from memory):

| Endpoint (base `https://www.wixapis.com`) | Method | What it does                                          | Does Gaugeline send it?                                                       |
| ----------------------------------------- | ------ | ----------------------------------------------------- | ----------------------------------------------------------------------------- |
| `/wix-data/v2/items/query`                | `POST` | Lists a collection's items; the query is in the body. | Yes, with a key set: `{ dataCollectionId, query: { cursorPaging, fields } }`. |
| `/wix-data/v2/items/count`                | `POST` | Counts a collection's items.                          | No. Items are counted by reading them to the end.                             |
| `/wix-data/v2/items/{dataItemId}`         | `GET`  | Reads one item, given its id and its collection's id. | No. The list already has the item.                                            |
| `/wix-data/v2/collections`                | `GET`  | Lists the collections: their fields and who may read. | No. You name the collections in the settings.                                 |

The body has no filter, no sort and no operator: the allowlist lists the two top-level keys `dataCollectionId` and `query` and no `$` operator, and the fetcher refuses a body that carries a write verb as a key anywhere, a statement such as `DELETE FROM` as a value, or an endpoint other than this one. A redirect is never followed, so the key cannot be sent anywhere else.

**The narrowest key** (uncited). Make an API key in the Wix account's API keys manager, choose its permissions one by one, and tick only the one that reads Wix Data items (for the site you check, and no other permission). A key with only that permission can read the collections and cannot add, change or remove an item. Gaugeline sends it in the `Authorization` header as it is (Wix API keys carry no `Bearer` prefix: uncited), with the site's id in a `wix-site-id` header, and over `https` only. The site's id is a setting (`siteId`), not a secret. A key Wix refuses, or that may not read one collection, is could-not-check for that collection, with the reason, and never a pass.

What the key never does here: it is never in an address, a body, a log, the saved requests file, a finding or a report; it is not sent to the checked site (the live-site read is anonymous); and nothing reads it unless `WIX_API_KEY` is set.

## Example: a career coach on Wix, with the key

Marlow Coaching is an invented one-person career-coaching practice. A freelancer built its site on Wix: a few pages, a blog, and two CMS collections, `Programs` (one dynamic page for each program) and `Testimonials`. The freelancer made a key with only the Wix Data read permission, but Wix gave it to the `Programs` collection and not to `Testimonials`. The key goes in the environment:

```text
WIX_API_KEY=<the API key, from the Wix API keys manager>
```

The settings name the collections (under `urls` and `fingerprint`), say where an item's page lives, and give the site's id:

```json title=gaugeline.adapters.json
{
  "adapters": [
    {
      "id": "wix",
      "siteId": "6b1f0c2e-3d4a-4e5f-9a8b-7c6d5e4f3a2b",
      "urls": {
        "Programs": "/programs/{slug}",
        "Testimonials": "/testimonials/{id}"
      },
      "fingerprint": {
        "Programs": ["title", "blurb"]
      }
    }
  ]
}
```

This is what the adapter reads over her site (invented), for programs changed since 1 October:

```json title=Output
{
  "collections": [
    {
      "type": "Programs",
      "count": 3
    },
    {
      "type": "Testimonials",
      "reason": "Wix did not accept WIX_API_KEY for the \"Testimonials\" collection, or the key may not read it (HTTP 403). Check it is a current API key for this site, and that its permissions include reading Wix Data items."
    }
  ],
  "Programs fields": {
    "title": 3,
    "blurb": 1,
    "slug": 3,
    "price": 0
  },
  "drafts reachable": "not-applicable",
  "Programs changed since 1 October": [
    {
      "id": "prog-spring-cohort",
      "type": "Programs",
      "url": "/programs/spring-cohort",
      "slug": "spring-cohort",
      "updatedAt": "2026-11-09T07:30:00.000Z",
      "fieldHashes": {
        "title": "9a6d8d128d4c47d9",
        "blurb": "70ca476b93967938"
      }
    },
    {
      "id": "prog-one-to-one",
      "type": "Programs",
      "url": "/programs/one-to-one",
      "slug": "one-to-one",
      "updatedAt": "2026-10-28T10:00:00.000Z",
      "fieldHashes": {
        "title": "e7874b51dbcf819f"
      }
    }
  ]
}
```

Read it the way the freelancer does:

- `Programs` has three items. `Testimonials` is **could not check**, with the reason: the key may not read it (HTTP 403). The other collection is still counted, so one missing permission does not hide the rest, and nothing is reported as fine for a collection that was not read.
- Of three programs, all have a title and a slug and one has a blurb. The spring cohort's blurb and the others' missing ones are the kind of drift a launch checklist misses.
- The spring cohort changed on 9 November, and its `fieldHashes` say which of the two named fields it has and fingerprint them: run it again after an edit and a changed hash tells you the field changed, without a word of the text in the report. The summer intensive (2 August) is left out by the date.
- Drafts are `not-applicable`: the query has no option for draft items, so Gaugeline never asks for them.

## Without a key: what the live-site read asks for

With no `WIX_API_KEY` set, every request is a `GET`, to the checked site and nowhere else, through the same fetcher as every other request. Wix's own servers (`www.wixapis.com`) are never asked, and no key is sent to the site.

- `GET /robots.txt`, for its `Sitemap:` lines.
- The sitemaps named there; with none, `GET /sitemap.xml`, then `/sitemap_index.xml` and `/wp-sitemap.xml`, stopping at the first that reads. A Wix site publishes its sitemap at `/sitemap.xml`, an index with one file for the pages and one for each part of the site that Wix generates, such as the blog or a collection's dynamic pages (uncited: Wix's pages could not be reached, so this is the usual layout and not a confirmed one; Gaugeline reads whichever files the index lists, and a site that names another in `robots.txt` or in the settings is read from there).
- The feeds the home page advertises; with none advertised, `/feed`, `/feed.xml`, `/rss.xml`, `/atom.xml` and `/feed.json`. A Wix blog has a feed; a site with no blog has none.

It reads the sitemap the way the [Sitemap and feeds](/docs/integrations/sitemap-feed) adapter does (that page has the limits, the dates and the safety rules, and they are the same here): only an address and its dates are kept, a title or a word of the client's text never is, and a sitemap that is missing, refused or unreadable is could-not-check, never an empty list. If one of the files an index lists is refused, the whole read is could-not-check and names the file; a list with a hole in it would make every "not in the list" answer wrong. It never asks for a page of the site: whether an address in the sitemap still answers is the job of the sitemap checks, not of an adapter.

### Example with no key: a career coach on Wix

Marlow Coaching is an invented one-person career-coaching practice. A freelancer built its site on Wix: a few pages (home, about, book a call), a blog, and a programs collection with one dynamic page for each program. The coach opens her Spring cohort for sign-ups from her phone the morning she sends her newsletter, and the freelancer wants to know which pages the site says changed lately.

Settings go in `gaugeline.adapters.json` in the project folder. The `site` line is only needed when the run is not given the address. With no key there is nothing to put in the environment:

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
  "field counts": "could not check: Not applicable to what Gaugeline can read from the live Wix site: a sitemap has no fields. To read the CMS collections, set WIX_API_KEY to a Wix API key with only the Wix Data read permission, set siteId, and name the collections under urls or fingerprint in gaugeline.adapters.json (docs/integrations/wix.md).",
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

- The Spring cohort page changed on 9 November, the morning of the newsletter. It is on the site's sitemap, so the site says it is published. Whether the CMS agrees (an item hidden in the CMS that still answers at its address, an item with no page) is what the key in the next section is for.
- The One to one program (28 October) and the "ninety-day plan" post (19 October) are left out: their dates are older. Their addresses are in the `programs` and `post` counts all the same.
- Field counts are could-not-check, with the reason (the next section is how to turn the CMS read on), and every `fieldHashes` is empty. The page's titles and prices are in the pages and never in the output.
- Drafts are `not-applicable`: the sitemap lists only what is published. Draft items saved in the Wix CMS are not visible from the site, and Gaugeline does not look.

## What a type means here

A sitemap has no content types, so a type is a group Gaugeline makes from the address, the same way the Sitemap and feeds adapter does: the first folder of the address, lower case (`/programs/spring-cohort` is `programs`), otherwise `top-level` for the home page and single-segment pages such as `/about`.

A Wix dynamic page lives under the path its owner set for the collection, so for most sites a type is a collection. Gaugeline cannot tell a collection from a folder of ordinary pages, and a site with a language prefix (`/en/about`) groups by language. Types are sorted by name, and `published()` filters by the same names.

## What it cannot check

| Question                                                          | Answer here                                          | Why                                                                                                                                 |
| ----------------------------------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| The CMS collections' items and fields, with no key                | could not check, "Not applicable"                    | The live site has no fields. Set `WIX_API_KEY` to read them.                                                                        |
| A collection the key may not read                                 | could not check for that collection, with the reason | The other collections are still read. `types()` names the refused one; `readCollections()` gives each collection's count or reason. |
| A collection you did not name                                     | not read                                             | Gaugeline does not list collections: it asks only for the ones under `urls` or `fingerprint`.                                       |
| How many items have each field (`fieldCounts`)                    | counted with a key; could not check with none        | A field counts when it has a value: not empty, not an empty list or object.                                                         |
| A hash of a field's value (`fieldHashes`)                         | only for the fields named under `fingerprint`        | With no field named, no field value is read at all. Without a key it is always empty.                                               |
| Are drafts reachable (`draftsReachable`)                          | `not-applicable`, with no request made               | The query Gaugeline sends has no option for draft items (uncited), so it never asks for them.                                       |
| Collection items that are hidden but still reachable at their URL | not checked                                          | It needs each item's hidden state and a request for its page. A later check, not this adapter.                                      |
| Collections with more than 10,000 items                           | could not check                                      | A count of part of a collection would be wrong. There is no flag to raise the limit.                                                |
| Who has access to the site (`members`)                            | not offered                                          | Not read.                                                                                                                           |

What the live-site read answers with no key is unchanged: which addresses the site says are published, and when they changed. The checks that read the sitemap against the pages (`sitemap-dead`, `sitemap-redirects`, `sitemap-host`) work on a Wix site as they do on any other.

## When it cannot check

It never returns a list with a hole in it. With the key, the read is could-not-check, in plain words, when the key is not one line of printable characters, `siteId` is missing, no collection is named, Wix refuses the key for a collection (HTTP 401 or 403) or has no such collection (HTTP 404), an answer is not a list of items, an item has no usable id or update time, a list says there is more and gives no way to read it, a cursor repeats, or a collection is longer than 10,000 items. A collection or item id that is not letters, digits, dots, hyphens and underscores is never sent. A slug that is not that is left out, and the item then has no address.

A rate limit (HTTP 429, or a 403 that says how long to wait) is waited for once when the wait is a minute or less; after that the run keeps what it had read and says it is partial.

Without the key, it is could-not-check when no sitemap and no feed could be read (it names where it looked), the site answers with a login (HTTP 401 or 403), a sitemap that `robots.txt`, an index or your settings name is missing or is not a sitemap, a file is larger than the cap, or the run has no site address.

## Settings

| `gaugeline.adapters.json` field | What it does                                                                                                                                            |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapters[].id`                 | `wix`.                                                                                                                                                  |
| `adapters[].siteId`             | The Wix site's id (a UUID, letters, digits and hyphens). Sent as `wix-site-id` with the key. Needed for the CMS read.                                   |
| `adapters[].urls`               | Where an item of a collection lives: `"/programs/{slug}"`. The keys are the collection IDs to read. `{slug}` is the item's `slug` field, `{id}` its id. |
| `adapters[].fingerprint`        | The fields to hash, by collection. Only these fields' values are read, and only to be hashed. The keys also name the collections to read.               |
| `adapters[].site`               | The site's address (`https://marlow-coaching.example`) for the live-site read. Wins over the address the run was given.                                 |
| `adapters[].sitemaps`           | Up to 10 sitemap files to read instead of looking: a path on the site or an https address on it. Each must answer, or the read is could-not-check.      |
| `adapters[].feeds`              | Up to 5 feeds to read instead of looking, likewise.                                                                                                     |

The key is not a setting. Keys come from the environment: `WIX_API_KEY`.

## Why the CMS read is a POST, and what stops it being anything else

Wix lists a collection's items only with Query Data Items, a `POST` (uncited). ADR-0001 says Gaugeline is read-only by construction, and ADR-0006 (open question 52, decided 11 November 2026) allows a `POST` for a documented read-only query endpoint on three conditions this adapter meets: it goes through `fetcher.query()` by the id of one registered allowlist entry (`wix-data-query`: host `www.wixapis.com`, path `/wix-data/v2/items/query`, a JSON body of the keys `dataCollectionId` and `query`); the entry carries Wix's documentation page and the date it was read (here: not read, marked); and every other rule holds (private addresses refused, no redirect followed, no key in a log). The request log shows the address and the entry's id and never the body. If Wix's page shows that Query Data Items can change something, or that a key which can read can also write, remove the entry and the adapter reads the live site only.

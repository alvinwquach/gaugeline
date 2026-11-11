# Contentstack: content checks for sites built on Contentstack

What a Contentstack site's CMS says is published, against what the live site shows. Gaugeline only reads: it asks the Content Delivery API for content types and published entries with a delivery token for one environment, and it never changes or deletes anything.

## What this adapter reads, and the narrowest key

**The key first.** Contentstack's narrowest key for this is a **delivery token for one environment**, together with the stack's **API key**. A delivery token belongs to one stack and one environment (for example `production`) and the Content Delivery API serves only what is published to that environment. The API has no write endpoint, so with these two values a program can read published content, and it cannot change or delete anything. The stack's API key is an identifier that the Contentstack client libraries put in the browser, not a secret on its own. Do not use a management token or an authtoken: they can write, and Gaugeline never asks for them. Gaugeline's key kind for Contentstack is `read-only`.

A delivery token cannot see drafts or entries that were never published to its environment. That is by design, and it means two things: Gaugeline answers "can this key reach unpublished work?" with no, and a Contentstack project that shows drafts to the public has to be checked another way.

This page lists what the adapter reads, a worked example for an agency's client, what it could not check and why, and what Gaugeline will not do. See [Content systems](/docs/integrations/) for the interface every adapter shares.

**A note on sources.** Documentation checked on: 2026-11-11. Contentstack's documentation (contentstack.com/docs) could not be reached from the build environment on that day, so the endpoint shapes below are from the Content Delivery API reference as the author knew it and are marked `uncited` where they could not be confirmed. Check this page against [the Content Delivery API reference](https://www.contentstack.com/docs/developers/apis/content-delivery-api) and [the API endpoints by region](https://www.contentstack.com/docs/developers/contentstack-regions/api-endpoints) before relying on a detail. [docs]

## What it reads

Every request is a `GET` over https to the delivery host of your region, through the same fetcher as every other request. Nothing else is ever sent.

| Endpoint                                              | What for                                                                                                                  |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `GET /v3/content_types`                               | The content types and the uids of their fields (`include_count=true`, `limit`, `skip`). `uncited`                         |
| `GET /v3/content_types/{uid}/entries?environment=...` | The published entries of a type: counts, fingerprints, field counts and the entry's URL field (`only[BASE][]`). `uncited` |

Both carry two headers, `api_key` and `access_token`, and nothing in the address but the environment name, paging and the names of the fields asked for. The adapter asks for the fields it needs and no others (`only[BASE][]`), never expands references (no `include[]`), and orders by `created_at` so a page boundary does not move while a list is read. Entries are read in the stack's master language only.

The regions and their delivery hosts are a fixed list; `CONTENTSTACK_REGION` picks one and a value that is not on the list is refused, so the key can only be sent to a Contentstack delivery host:

| `CONTENTSTACK_REGION` | Delivery host                   |
| --------------------- | ------------------------------- |
| `us` (the default)    | `cdn.contentstack.io`           |
| `eu`                  | `eu-cdn.contentstack.com`       |
| `au`                  | `au-cdn.contentstack.com`       |
| `azure-na`            | `azure-na-cdn.contentstack.com` |
| `azure-eu`            | `azure-eu-cdn.contentstack.com` |
| `gcp-na`              | `gcp-na-cdn.contentstack.com`   |
| `gcp-eu`              | `gcp-eu-cdn.contentstack.com`   |

The `au`, `gcp-na` and `gcp-eu` hosts are `uncited`.

Entries are read a page at a time. The next page starts after the entries that came back, not after the page size that was asked for, so a server that sends fewer than 100 loses nothing; the list ends when the count the API reports has been read. A page that is too big is asked again with half as many entries, down to 10, and only then is the type could-not-check. A page that comes back empty before the count is could-not-check. When the platform answers 429 with a short `Retry-After`, Gaugeline waits once and goes on; after that it keeps what it read and says the result is partial.

## Make the key

In Contentstack, open the stack, then **Settings**, **Tokens**, **Delivery Tokens**, and create a token for the one environment the live site is built from (usually `production`). Copy the token, and the stack's API key from **Settings**, **Stack**. Put them in the environment where Gaugeline runs, never in a file you commit:

```text
CONTENTSTACK_API_KEY=<the stack's API key>
CONTENTSTACK_DELIVERY_TOKEN=<the delivery token>
CONTENTSTACK_ENVIRONMENT=production
CONTENTSTACK_REGION=eu
```

`CONTENTSTACK_ENVIRONMENT` is required: Gaugeline never guesses the environment. `CONTENTSTACK_REGION` can be left out for the US region. Both keys go in headers and never in an address, they are sent only to the delivery host, a redirect to another address carries neither, and every message, finding and report has them blanked. Only https is used.

### What reaches your computer

The entries list sends only the fields Gaugeline names in `only[BASE][]`: the system fields, the entry's `url` field when the type has one, and the fields the settings name in `fingerprint`. Field values are used for exactly two things: counting which entries have a field and hashing the fields the settings name. The adapter keeps no value, and nothing but the short hash is printed, logged or put in a finding or report. With no `fingerprint` in the settings, nothing is hashed at all.

## Example: a boutique hotel moving to Contentstack

Harbour Lantern Inn is an invented boutique hotel. An agency is migrating its site from an older CMS to Contentstack, with a Next.js front end on Vercel: rooms and offers (one page each) and the team (no pages of their own). The front end builds a page for each room from the entry's `url` field. Before the cutover the agency wants to know that every room and offer the owner published in Contentstack has a page, and that a room saved but not yet published stays out of sight.

Settings go in `gaugeline.adapters.json` in the project folder. Nothing in it is a key.

```json title=gaugeline.adapters.json
{
  "adapters": [
    {
      "id": "contentstack",
      "fingerprint": {
        "rooms": ["title", "summary"]
      },
      "urls": {
        "rooms": "/rooms/{slug}",
        "offers": "/offers/{slug}"
      }
    }
  ]
}
```

Without `urls`, the address of an entry is the path in its own `url` field (one path with a single leading slash; anything else is dropped and the entry has no address). With `urls`, the pattern wins and `{slug}` is the last part of the entry's `url` path. Here is what the adapter reads over the invented site. A room that was never published to the environment is in no count and no list: a delivery token cannot see it.

```json title=Output
{
  "types": [
    {
      "name": "offers",
      "count": 1
    },
    {
      "name": "rooms",
      "count": 2
    },
    {
      "name": "team",
      "count": 2
    }
  ],
  "room fields": {
    "title": 2,
    "summary": 1,
    "seats": 2
  },
  "a type that does not exist": "The stack has no content type named none, or the delivery token cannot see it. Its content types are: offers, rooms, team.",
  "drafts reachable": false,
  "published rooms": [
    {
      "id": "blt0a1b2c3d4e5f0101",
      "type": "rooms",
      "url": "/rooms/harbour-view",
      "slug": "harbour-view",
      "updatedAt": "2026-10-20T08:30:00.000Z",
      "fieldHashes": {
        "title": "f92b9af8ad51b20c",
        "summary": "715d70132521b83d"
      }
    },
    {
      "id": "blt0a1b2c3d4e5f0102",
      "type": "rooms",
      "url": "/rooms/garden",
      "slug": "garden",
      "updatedAt": "2026-11-02T17:00:00.000Z",
      "fieldHashes": {
        "title": "e91598dd19df1d55"
      }
    }
  ]
}
```

The agency reads it like this: three types, two rooms and one offer live, and the team has no pages. `summary` is on one room of two, so a page that shows a summary for the other is a difference worth a look. The unknown type is could-not-check with the names of the types the token can see, not "nothing published". Drafts are out of reach of the token, so a draft can never show on the site through it. Run with `--published` and the checks that compare the CMS with the live site (`live-page-missing`, `published-not-live`, `unpublished-still-live`) use these entries: a room whose page answers 404 is reported by its slug and its address, never by its title.

## Extra checks for Contentstack

- **Published to the environment but missing from the live site.** The `live-page-missing` check of `--published` over this adapter: each entry changed lately is asked for at its address (a GET), and a 404 or 410 is a finding. See [Published but not live](/docs/guides/published-not-live).
- **A preview token in the site's JavaScript.** A Contentstack preview token reads drafts. The `secret-in-js` check reports one in the scripts a page sends, by kind and place and with no character of the token: a value of `cs` and hex whose name says `preview` in a file that names Contentstack, or that is next to the Live Preview host (`rest-preview.contentstack.com`) in the same object. The delivery token and the stack's API key are public by design and are never reported. The token shape is `uncited`. The check reads only scripts the site already serves to every visitor; it asks for no path that is not public.

## What cannot be checked

Anything the platform does not expose is could-not-check, with the reason, never a pass and never scraped from the platform's admin screens:

| Question                                | Answer here      | Why                                                                                                    |
| --------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------ |
| Who has access to the stack (`members`) | not offered      | The Content Delivery API does not list users, and Gaugeline does not use a management token.           |
| Drafts and unpublished entries          | out of reach     | A delivery token reads only what is published to its environment. Gaugeline takes no preview token.    |
| Whether a page shows the same words     | not decided here | The adapter gives hashes; comparing them with the page is another check.                               |
| Entries in other languages              | not read         | Only the stack's master language is read.                                                              |
| Other environments                      | not read         | A delivery token is for one environment; set `CONTENTSTACK_ENVIRONMENT` to the one the live site uses. |
| A content type the token cannot see     | could-not-check  | The type is named in the reason, and is never counted as "nothing published".                          |
| Endpoints that need a POST              | not used         | Gaugeline sends no POST to Contentstack. A question that needs one is could-not-check.                 |

## When it cannot check

It never returns a list with a hole in it. The read is could-not-check, with the reason in plain words, when:

- `CONTENTSTACK_API_KEY`, `CONTENTSTACK_DELIVERY_TOKEN` or `CONTENTSTACK_ENVIRONMENT` is not set (nothing is asked), or is not a plain value, or `CONTENTSTACK_REGION` is not on the list above;
- the platform does not accept the token or the stack key (HTTP 401), or the token may not read a type (HTTP 403): the reason names the type, and a read of other types still works when the types are named;
- the environment or the content type is not known to the token (HTTP 404 or 422);
- an answer is not the shape the platform sends, a uid or a count is not valid, or an entry has no uid or no update time;
- a type is bigger than the bound, a page of entries is too big even at 10, the list stops before its count, the pages are too small to read the count in a sane number of requests, the same entry comes back twice, or a run needs more requests than the bound.

A platform that asks Gaugeline to slow down (HTTP 429) is waited for once when it says how long and the wait is a minute or less; after that the run keeps what it had read and says it is partial.

## What is bounded

| Limit                         | Value  |
| ----------------------------- | ------ |
| Entries in one page of a list | 100    |
| Entries read from one type    | 10,000 |
| Content types read            | 1,000  |
| Requests in one run           | 3,000  |

There are no flags to raise them.

## Settings

| `gaugeline.adapters.json` field | What it does                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------- |
| `adapters[].id`                 | `contentstack`.                                                                                |
| `adapters[].fingerprint`        | Fields to hash, by content type uid. Up to 20 per type.                                        |
| `adapters[].urls`               | Where a type's pages live: a path or an https address. Only `{slug}` and `{id}` are filled in. |

| Environment variable          | What it is                                                                                     |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `CONTENTSTACK_API_KEY`        | The stack's API key (header `api_key`).                                                        |
| `CONTENTSTACK_DELIVERY_TOKEN` | A delivery token for one environment (header `access_token`). It reads published content only. |
| `CONTENTSTACK_ENVIRONMENT`    | The environment the token is for, such as `production`. Required.                              |
| `CONTENTSTACK_REGION`         | `us` (the default), `eu`, `au`, `azure-na`, `azure-eu`, `gcp-na` or `gcp-eu`.                  |

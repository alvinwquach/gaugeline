# Adobe Experience Manager: content checks for sites built on AEM

What an Adobe Experience Manager (AEM) site's content says is published, against what the live site shows. Gaugeline only reads: it runs the persisted GraphQL queries your developers already published for the Content Fragments, over `GET`, on the public publish tier, and it needs no key at all. It never touches the author tier and never changes anything.

## What this adapter reads, and the narrowest key

**The key first.** The narrowest key is **no key**. AEM has two tiers: the author tier, where editors work and which needs a login, and the **publish tier**, which serves what is published to every visitor. Gaugeline reads the publish tier only, anonymously, so there is no technical account, no service credential and no token to make. Its key kind is `read-only`, with no key at all. If a persisted query is protected on your publish tier (HTTP 401 or 403), that query is could-not-check and Gaugeline says so; it does not ask for a login, and a technical account limited to read on the fragment paths is not supported by this adapter.

The one thing the site's developers must have done is publish a persisted query for each list of fragments (in AEM, persisted queries are saved on the author tier and published with the content). Gaugeline cannot create one, because creating a persisted query is a write. Name the queries in the settings: the name of a persisted query is the "type" the rest of Gaugeline uses.

This page lists what the adapter reads, a worked example for an agency's client, the two extra checks, what it could not check and why, and what Gaugeline will not do. See [Content systems](/docs/integrations/) for the interface every adapter shares.

**A note on sources.** Documentation checked on: 2026-11-11. Adobe's documentation (experienceleague.adobe.com) could not be reached from the build environment on that day, so every shape below is from AEM's GraphQL API for Content Fragments as the author knew it and is marked `uncited`. Check this page against [Adobe's documentation for persisted queries](https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/headless/graphql-api/persisted-queries) before relying on a detail. [docs]

## What it reads

Every request is a `GET` over https to the publish origin you give, through the same fetcher as every other request. Nothing else is ever sent: no `POST` (a GraphQL `POST` is not used, the persisted-query `GET` is the whole read), no cookie, no `Authorization` header, and a redirect is not followed.

| Endpoint                                                              | What for                                                                                                  |
| --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `GET /graphql/execute.json/{config}/{query}` (`uncited`)              | The fragments a persisted query lists: counts, fingerprints and field counts.                             |
| `GET /graphql/execute.json/{config}/{query};first=100;after={cursor}` | The next page of a paginated query (`edges` and `pageInfo`), when `pageInfo` says there is one. `uncited` |

Set two variables where Gaugeline runs. Neither is a secret:

```text
AEM_PUBLISH_URL=https://www.harbourline-hotels.example
AEM_CONFIG=harbourline
```

`AEM_PUBLISH_URL` must be an https address with a host and nothing else (no path, query, user name or password), and not an author host (`author.` or `author-p...-e....adobeaemcloud.com`): the address is the client's own origin and every request goes there. `AEM_CONFIG` is one name, the configuration the queries were published under (the part after `/graphql/execute.json/`); letters, digits, hyphens and underscores only. A persisted query name from the settings is held to the same rule before it is put in an address, so a name cannot add a path part.

A persisted query must return exactly one list, either `items` (a list query) or `edges` with `node` (a paginated query), and each fragment must include `_path`. A fragment's `_path` must be `/content/dam/` and plain path segments (no `..`, no `%`, no second leading slash, no host); anything else makes the query could-not-check and the path is never repeated. The fragment's id is made from its path, and its slug is the last segment of the path. If the query returns the fragment's modification time (`_metadata { calendarMetadata { name value } }` with `cq:lastModified` or `jcr:lastModified`, `uncited`), it is used for the "published but missing from the page" check; with no time the fragment is counted as undated and that check says so.

A paginated query is followed by the cursor it gives: `;first=100;after={cursor}`, with the cursor held to a plain token of at most 512 characters and percent-encoded. It stops at `hasNextPage: false`. It is could-not-check, never a short list taken for the whole, when the same cursor comes twice, an empty page promises another, a fragment is listed twice, a query has more than 200 pages or more than 10,000 fragments. A list query that has no `pageInfo` and answers 50 fragments or more may have been cut short by the platform's own default limit, so it is could-not-check too: use the paginated form. When the platform answers 429 with a short `Retry-After`, Gaugeline waits once and goes on; after that it keeps what it read and says the result is partial.

### What reaches your computer

A persisted query's answer carries the fields the developers put in it, so Gaugeline receives them. Field values are used for exactly two things: counting which fragments have a field and hashing the fields the settings name. The adapter keeps no value, and nothing but the short hash is printed, logged or put in a finding or report. With no `fingerprint` in the settings, nothing is hashed at all. A GraphQL `errors` list in a 200 answer is could-not-check, and its messages (which can quote content) are not repeated.

## Example: a hotel group on AEM Sites

Harbourline Hotels is an invented hotel group. A freelancer's agency built its site on AEM Sites: rooms, offers and venues are Content Fragments, one page each, and the group's marketing team publishes from AEM. The agency wants to know two things the editors never tell it: whether a room the team published has a page on the live site, and whether the page shows what the team published.

The agency asks the developers for the names of three persisted queries (`rooms`, `offers`, `venues`) and writes them in `gaugeline.adapters.json` in the project folder. Nothing in it is a key.

```json title=gaugeline.adapters.json
{
  "adapters": [
    {
      "id": "aem",
      "fingerprint": {
        "rooms": ["name", "summary"]
      },
      "urls": {
        "rooms": "/rooms/{slug}",
        "offers": "/offers/{slug}",
        "venues": "/venues/{slug}"
      }
    }
  ]
}
```

Reading the invented publish tier gives (an asserted test compares this block with the tool):

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
      "name": "venues",
      "count": 2
    }
  ],
  "room fields": {
    "name": 2,
    "summary": 1,
    "sleeps": 2,
    "subtitle": 0
  },
  "a query that is not named": "\"spa\" is not a persisted query named in gaugeline.adapters.json, so it was not read.",
  "drafts reachable": "not-applicable",
  "published rooms": [
    {
      "id": "harbourline.en.rooms.harbour-view",
      "type": "rooms",
      "url": "/rooms/harbour-view",
      "slug": "harbour-view",
      "updatedAt": "2026-10-20T08:30:00.000Z",
      "fieldHashes": {
        "name": "8d7e84998b906d71",
        "summary": "69dc18dee27fc0e3"
      }
    },
    {
      "id": "harbourline.en.rooms.garden",
      "type": "rooms",
      "url": "/rooms/garden",
      "slug": "garden",
      "updatedAt": "2026-11-02T17:00:00.000Z",
      "fieldHashes": {
        "name": "d35ac3a64d1e9499"
      }
    }
  ]
}
```

Read it the way the agency does. Rooms has two published fragments, and one of them has no `summary`, which the field counts show without reading the text. The draft winter suite saved on the author tier is not in the publish tier's answer, so Gaugeline never sees it and says drafts are not applicable. Each published room has an address from the pattern, a slug from its path, a time from the query and a short hash of each named field: the hash changes when the editors change the field, which is how `gaugeline --published` notices a page that still shows the old words. A query that is not named in the settings is could-not-check, never an empty type.

## The two extra checks

**Fragments published but missing from the page.** This is the published-not-live check that runs over every adapter, fed by AEM's fragments: a fragment on the publish tier whose page, built from the `urls` pattern, answers 404 or 410 is `live-page-missing`; one whose page title differs from the fragment's field is `published-not-live`. Evidence names the slug and the field name, never the words. Run it with `gaugeline --published`. A fragment with no modification time cannot be placed in the "changed in the last N days" window, so it is counted as undated.

**Author-tier URLs linked from the live site** (`aem-author-links`). A page that links to the editors' side is reported: a link whose host is an author host (`author.` followed by your domain, or `author-p{n}-e{n}.adobeaemcloud.com`), or whose path on the page's own host starts `/editor.html`, `/crx/` or `/libs/`, or is `/ui` with a `#/aem` fragment. This reads only the pages the site already serves, so it is not a probing check and needs no consent. Evidence shows the host and path of each link, never a query string. The usual cause is an editor pasting the address from their own browser into a link field. Another site's `/editor.html` is never taken for yours: an editors' path counts only on the page's own host.

## What cannot be checked

Anything the platform does not expose is could-not-check, with the reason, never a pass and never scraped from the author tier or its admin screens:

| Question                                                             | Answer here            | Why                                                                                                                                |
| -------------------------------------------------------------------- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Which persisted queries exist                                        | not listed             | Listing them is an author-tier read that needs a login; name them in the settings.                                                 |
| Drafts and unpublished fragments                                     | not applicable         | The publish tier serves only what is published. Gaugeline never asks the author tier.                                              |
| A query the publish tier protects (401 or 403)                       | could not check        | Gaugeline sends no login. That query only; the others are read. A technical account is not supported by this adapter.              |
| Who has access to the site (`members`)                               | not offered            | AEM's users and groups are an author-tier read.                                                                                    |
| Whether a page shows the same words                                  | not decided here       | The adapter gives hashes; comparing them with the page is the published-not-live check.                                            |
| Fragments in other languages or variations                           | what the query returns | Gaugeline reads what the persisted query lists and nothing else.                                                                   |
| A `POST` GraphQL endpoint (`/content/_cq_graphql/.../endpoint.json`) | not used               | A `POST` is allowed only for documented read-only queries through the fetcher's allowlist; this adapter needs none and sends none. |

## When it cannot check

It never returns a list with a hole in it. The read is could-not-check, with the reason in plain words, when:

- `AEM_PUBLISH_URL` or `AEM_CONFIG` is missing or is not what is described above, or no persisted query is named in the settings;
- the publish tier answers 401, 403, 404, a redirect or any other status for a query, or answers something that is not JSON or not the shape above;
- the answer has GraphQL `errors`, no list or more than one list, or a fragment without a usable `_path`;
- a paginated query repeats a cursor, sends an empty page that promises another, lists a fragment twice, or is longer than the bounds below, or a list with no `pageInfo` answers 50 fragments or more.

A platform that asks Gaugeline to slow down (HTTP 429) is waited for once when it says how long and the wait is a minute or less; after that the run keeps what it had read and says it is partial. The read stops at the first persisted query it cannot read, and says which; remove or fix that name to read the rest.

## What is bounded

| Limit                                           | Value  |
| ----------------------------------------------- | ------ |
| Fragments asked for in one page (`first`)       | 100    |
| Fragments read from one persisted query         | 10,000 |
| Pages read from one persisted query             | 200    |
| Largest list with no `pageInfo` that is trusted | 49     |

There are no flags to raise them.

## Settings

| `gaugeline.adapters.json` field | What it does                                                                                                                                  |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapters[].id`                 | `aem`.                                                                                                                                        |
| `adapters[].fingerprint`        | Fields to hash, by persisted query name. Up to 20 per query. A name here (or in `urls`) is a persisted query that is read.                    |
| `adapters[].urls`               | Where a query's pages live: a path or an https address. Only `{slug}` and `{id}` are filled in. The slug is the fragment's last path segment. |

## Reference

- Persisted queries and the execute endpoint: [Adobe's persisted queries documentation](https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/headless/graphql-api/persisted-queries) (`uncited`: not reachable on 2026-11-11). [docs]
- GraphQL API for Content Fragments: [Adobe's documentation](https://experienceleague.adobe.com/en/docs/experience-manager-cloud-service/content/headless/graphql-api/content-fragments) (`uncited`). [docs]

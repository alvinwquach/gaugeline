# Umbraco: content checks for sites built on Umbraco

What an Umbraco site's Content Delivery API says is published, against what the live site shows. Gaugeline only reads, and it asks for no key at all when the API is public and the Delivery API key when it is protected.

## What this adapter reads, and the narrowest key

**The key first.** Umbraco 13 and newer has a read-only Content Delivery API, and it is switched off until the site's owner turns it on (`Umbraco:CMS:DeliveryApi:Enabled`). If the owner also sets `PublicAccess` to `true`, the API answers visitors with no key and **Gaugeline asks for none**. If `PublicAccess` is `false`, every request must carry the Delivery API key in an `Api-Key` header, and that is the only key Gaugeline asks for: the Delivery API has no write routes, so with it a program can read published content and, when it asks for preview, unpublished content, and cannot create, change or delete anything. Gaugeline's key kind for Umbraco is `read-only`. Umbraco has no read-only user or token for the backoffice and Gaugeline never uses the backoffice or its Management API.

The address and the key come from the environment, never from a file you commit:

```text
UMBRACO_URL=https://www.client.example
UMBRACO_API_KEY=<the Delivery API key; leave unset if the API is public>
```

`UMBRACO_URL` is the Umbraco site's own address: `https` only, no path, no sign-in details. The key goes in the `Api-Key` header and never in an address, it is sent only to that origin, it is dropped if the server redirects to another origin or to `http`, and every message, finding and report has it blanked. A freelancer's client for this page: a community theatre, a pop-up or a clinic with a brochure site on Umbraco. The example below is Marigold Lane Community Theatre, invented.

**A note on sources.** Umbraco's own documentation could not be reached when this page was written (the build session's network policy refused `docs.umbraco.com`). Documentation checked on: 2026-11-11, which means it was not read: the routes, parameters, headers and answer shapes below are from the build's knowledge of the Delivery API in Umbraco 13 and are pinned by Gaugeline's tests over invented answers, not confirmed against the live pages. Each is marked `uncited` where it matters. Check them against the current pages before relying on a detail: [Content Delivery API](https://docs.umbraco.com/umbraco-cms/reference/content-delivery-api) [docs], [querying the API](https://docs.umbraco.com/umbraco-cms/reference/content-delivery-api/querying-the-content-delivery-api) [docs], [protecting the API](https://docs.umbraco.com/umbraco-cms/reference/content-delivery-api/protected-content-in-the-delivery-api) [docs], [previewing content](https://docs.umbraco.com/umbraco-cms/reference/content-delivery-api/previewing-content) [docs].

This page lists the routes read, how to set the key, a worked example, what the two Umbraco checks find, what could not be checked, and what Gaugeline will not do. See [Content systems](/docs/integrations/) for the interface every adapter shares.

## What it reads

Every request is a `GET` to your `UMBRACO_URL`, through the same fetcher as every other request. Nothing else is ever sent.

| Request                                                           | Key                          | What for                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------- | ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /umbraco/delivery/api/v2/content?filter=contentType:{alias}` | only if the API is protected | The published nodes of a content type you named: counts, fingerprints and field counts. `skip` and `take` page it, `sort=createDate:asc` keeps it stable, `fields=properties[a,b]` asks only for the properties you hash (`properties[]` for none) and `expand=none` expands nothing. `uncited` |
| the same, with the header `Preview: true`                         | the Delivery API key, always | A count of what the API shows to preview, compared with the published count, for whether unpublished work is reachable with the key. `uncited`                                                                                                                                                  |
| the same with `take=1`, and no key                                | none                         | Only with `--owner-consent`: what a visitor is told. See [the two checks](#the-two-checks).                                                                                                                                                                                                     |
| one `GET` of each node's page on the live site                    | none                         | For the node-with-no-page check: the route the API gave the node, or the pattern in `urls`.                                                                                                                                                                                                     |

**The Delivery API does not list content types.** So you name the types to read, by their alias (such as `show`), as keys of `urls` or `fingerprint` in `gaugeline.adapters.json`. A type you do not name is not read. A mistyped alias is not an error to the API: it answers a total of 0, so a type that counts 0 may be misspelled.

A node's page address is the `route.path` the API gives it, unless `urls` has a pattern for its type (the pattern wins). Paths are checked before they are used: one leading `/`, never a host (`//`), a scheme, `..`, a backslash or an escaped dot or slash. A route is only an address together with its start item (the root node it is relative to). A node whose route has no start item is not given an address, and when the nodes read come from more than one start item (several sites or domains in one Umbraco), no route path is asked on your site: those nodes are could-not-check by name unless `urls` has a pattern for their type, because Gaugeline cannot tell which root is the site being checked.

Lists are read a window at a time. The window moves by the number of nodes that came back, never by the number asked for, because the API may give fewer than asked. A list is complete only when the position reaches the total the API reports: an empty window before the total, a window with only nodes already seen, a total that is not a count, a type with more than 10,000 nodes and a list that needs more than 500 requests are all could-not-check, never a count of part of the list. When Umbraco answers 429 with a short `Retry-After`, Gaugeline waits once and goes on; after that it keeps what it read and says the result is partial.

### What reaches your computer

A node's list entry carries its name, dates, route and (unless a request limits it) every property. Gaugeline asks only for the properties named in `fingerprint`, expands nothing, and keeps only the node's id, type, update time, route and those properties, and only until they are counted or hashed. The name of a node is never kept. Nothing but the short hash is printed, logged or put in a finding or report. With no `fingerprint` in the settings no property is asked for.

## Example: a community theatre on Umbraco

Marigold Lane Community Theatre is an invented volunteer-run theatre. A freelancer built its site on Umbraco: shows (one page each), cast members (one page each) and a few news notices. The treasurer edits the site from the box office between rehearsals, and saves the next show as a draft long before it is announced. The freelancer wants to know, before the treasurer does, which published shows have no page, and whether the Delivery API is open to anyone when it was meant to be private.

Settings go in `gaugeline.adapters.json` in the project folder. Nothing in it is a key.

```json title=gaugeline.adapters.json
{
  "adapters": [
    {
      "id": "umbraco",
      "fingerprint": { "show": ["title", "blurb"] },
      "urls": { "show": "/whats-on/{slug}", "castMember": "/company/{slug}" }
    }
  ]
}
```

With `UMBRACO_URL` and `UMBRACO_API_KEY` in the environment, this is what the adapter reads over the theatre's Umbraco (invented: one show saved as a draft, and the API protected):

```json title=Output
{
  "types": [
    {
      "name": "castMember",
      "count": 2
    },
    {
      "name": "show",
      "count": 2
    }
  ],
  "show fields": {
    "title": 2,
    "blurb": 1,
    "seats": 2
  },
  "a type with no published nodes": {
    "title": 0
  },
  "drafts reachable": true,
  "published shows": [
    {
      "id": "3f6c8a10-5b7e-4c21-9d34-a1b2c3d4e5f6",
      "type": "show",
      "url": "/whats-on/the-lantern-keeper",
      "slug": "the-lantern-keeper",
      "updatedAt": "2026-10-20T08:30:00.000Z",
      "fieldHashes": {
        "title": "32fa49a21d733163",
        "blurb": "b7fc30531cb07e26"
      }
    },
    {
      "id": "7a1e9b52-0c3d-4f68-8e47-b2c3d4e5f6a7",
      "type": "show",
      "url": "/whats-on/winter-panto",
      "slug": "winter-panto",
      "updatedAt": "2026-11-02T17:00:00.000Z",
      "fieldHashes": {
        "title": "3017bb272702e0ce"
      }
    }
  ]
}
```

The types are the ones named in the settings, with the published count of each: the draft show is not counted. `show fields` says two published shows have a title and one has a blurb (the panto has none, so it has no `blurb` hash rather than the hash of an empty text). The type with no published nodes counts 0 for every field: a mistyped alias looks the same. `drafts reachable` is true because the key, asking for preview, is shown more shows than the public list holds: the spring show is saved and not published. Nothing here is the theatre's words, only counts, ids, paths, dates and hashes.

## The two checks

These two checks run from one read of the Umbraco site (`readUmbraco`), not from a page, so they are listed in the [checks reference](/docs/checks) and not in a page run.

**`umbraco-node-no-page`: A published Umbraco node has no page on the live site.** For each node the API says is published and that has an address, Gaugeline asks the live site for that page once. A final 404 or 410 is the finding, and it names the content type, the node's slug (or id) and the path, never its text. Any other answer that is not a 2xx is could-not-check for that page. A node with no route and no pattern, a path that is not a plain path, and pages past the run's budget of 300 are could-not-check by name, never skipped quietly. To fix one: check the content type has a template (or the front end builds a route for it), that the node's culture and domain settings match the site being checked, and that a headless front end was rebuilt after publishing.

**`umbraco-delivery-api-public`: The Umbraco Delivery API answers visitors with no key.** This is a **probing** check: it asks a route a visitor is not meant to use when the API is private. **It is off unless you run with `--owner-consent` (or a `gaugeline.consent.json` entry), and you should run it only on sites you own or have permission to test.** It also runs only when you say the API is meant to be private, with `"expectPrivate": true` in the `umbraco` entry of `gaugeline.adapters.json`. Setting `UMBRACO_API_KEY` does not say it: a public API with a key is a normal setup, because preview needs the key on a public API too. Without `expectPrivate` the check is could-not-check ("no privacy expectation given"), and a public API you never said was private is not a finding. It sends one `GET` of `/umbraco/delivery/api/v2/content?take=1` with no `Api-Key`, no cookie and no preview header. A 200 with a list and a numeric total is the finding, and the evidence is the count of nodes the API reported, never a node. A 401 or 403 is a protected API and a 404 is an API that is off or not at that address: neither is a finding. A 200 that is not the API's list (a front end that answers every path with a page) and any other status are could-not-check. To fix it: set `Umbraco:CMS:DeliveryApi:PublicAccess` to `false` and keep an `ApiKey`, and send the key from the server, never from the browser. If the API is meant to be public, remove `expectPrivate`; the key stays.

## What cannot be checked

Anything the platform does not expose is could-not-check, with the reason, never a pass and never scraped from the backoffice:

| Question                                                    | Answer here      | Why                                                                                                                                                                                                              |
| ----------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Which content types exist                                   | you name them    | The Delivery API has no list of content types, and the backoffice is never used.                                                                                                                                 |
| Who has access to the site (`members`)                      | not offered      | The Delivery API does not list backoffice users.                                                                                                                                                                 |
| Whether a page shows the same words                         | not decided here | The adapter gives hashes; comparing them with the page is another check.                                                                                                                                         |
| Nodes in other languages                                    | not read         | Requests carry no `Accept-Language`, so the API answers for the site's default language.                                                                                                                         |
| A type that gives no published node                         | could-not-check  | A mistyped alias, a hidden type or content only in another language all answer 0. A named type with 0 published nodes is could-not-check by name, never a pass.                                                  |
| Whether unpublished work is reachable when the counts match | could-not-check  | Preview showing no more nodes than the public list does not show nothing is unpublished (the server may ignore `Preview`, or a draft may be an edit to a published node). Only more nodes with preview is a yes. |
| Content types the Delivery API is told to hide              | not read         | `DisallowedContentTypeAliases` hides them from the API. A hidden type counts 0.                                                                                                                                  |
| A node's publish date                                       | left out         | The API gives a created date and an updated date, and no publish date; Gaugeline does not make one up.                                                                                                           |
| Whether unpublished work is reachable                       | needs the key    | Preview needs the Delivery API key. Without it, the answer is could-not-check and nothing is asked.                                                                                                              |

## When it cannot check

It never returns a list with a hole in it. The read is could-not-check, with the reason in plain words, when:

- `UMBRACO_URL` is not set or is not an `https` site address (nothing is asked), or no content type is named in the settings;
- the API answers 401 (the key is missing, or is not the one in the site's `ApiKey` setting) or 403, or 404 (the API is off, or `UMBRACO_URL` is not the Umbraco site);
- an answer is not the shape the API sends, a node has no usable id or no update time, or a node is of another type than the one asked for;
- a type is bigger than the bound, a window is too big even at 10 nodes, the list stops before its total, repeats itself, or needs more than 500 requests.

Pages are read in `createDate` order, which can tie: if the windows repeat a node and so leave another out (the nodes seen are fewer than the total), the list is could-not-check, never a clean list. A tie-breaker in the sort is `uncited` and is not sent.

A key refused for one type is could-not-check for that type only: the other types are still read.

## What is bounded

| Limit                           | Value  |
| ------------------------------- | ------ |
| Nodes asked for in one request  | 100    |
| Nodes read from one type        | 10,000 |
| Requests spent on one list      | 500    |
| Live pages asked for in one run | 300    |

There are no flags to raise them.

## Settings

| `gaugeline.adapters.json` field | What it does                                                                                                                              |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `adapters[].id`                 | `umbraco`.                                                                                                                                |
| `adapters[].fingerprint`        | Properties to hash, by content type alias. Up to 20 per type. A dotted name goes into the property's object.                              |
| `adapters[].expectPrivate`      | `true` says the Delivery API is meant to be private, which switches on `umbraco-delivery-api-public` (still only with `--owner-consent`). |
| `adapters[].urls`               | Where a type's pages live: a path or an https address. Only `{slug}` and `{id}` are filled in. Wins over the route the API gives.         |

| Environment variable | What it is                                                                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `UMBRACO_URL`        | The Umbraco site's address (https, no path). Not a key.                                                                                                               |
| `UMBRACO_API_KEY`    | The Delivery API key, sent in `Api-Key`. Only if the API is protected, and for preview (`drafts reachable`). It does not say the API is private: use `expectPrivate`. |

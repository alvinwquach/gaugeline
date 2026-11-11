# Strapi: content checks for sites built on Strapi

## What this adapter reads, and the narrowest key

Gaugeline only reads. For a Strapi backend it sends `GET` requests to the REST API (`/api/{collection}`), and nothing else: no `POST`, no `PUT`, no `DELETE`, no GraphQL (Strapi's GraphQL plugin takes queries as `POST`, which waits for the read-only `POST` rule in ADR-0006).

**The narrowest key is an API token of type Read-only.** In Strapi's admin you make it under **Settings, API Tokens**: choose the type **Read-only**, name it `Gaugeline, read only`, and set an expiry. A Read-only token can `find` and `findOne` the content types and cannot create, update or delete anything. If you want it narrower still, choose the type **Custom** and tick only `find` and `findOne` on the collections you will name to Gaugeline. Gaugeline's key kind for Strapi is `read-only`.

The token comes from the environment, goes in an `Authorization` header and never in an address, is sent only to the Strapi address you configured and only over `https`, is dropped if the server redirects to another origin, and is blanked in every message, finding and report.

```text
STRAPI_URL=https://cms.client.example
STRAPI_TOKEN=<the read-only API token>
```

A freelancer's client for this page: a coach or a bar with a Next.js site on a Strapi backend. The example below is Brass Anchor Taproom, an invented neighbourhood bar.

**A note on sources.** Strapi's own documentation could not be reached when this page was written (the build session's network policy refused `docs.strapi.io`). The endpoint paths, the answer shapes, the token types and the draft parameters below are from the build's knowledge of Strapi 5 and Strapi 4, and each is pinned by Gaugeline's tests over invented answers, not confirmed against the live pages. Check them against the current Strapi docs before relying on a detail: [API tokens](https://docs.strapi.io/cms/features/api-tokens) [docs], [REST API](https://docs.strapi.io/cms/api/rest) [docs], [pagination and sorting](https://docs.strapi.io/cms/api/rest/sort-pagination) [docs], [draft and publish status](https://docs.strapi.io/cms/api/rest/status) [docs], [Users & Permissions](https://docs.strapi.io/cms/features/users-permissions) [docs].

This page lists the endpoints, how to make the token, a worked example, what the two Strapi checks find, and what Gaugeline will not do. See [Content systems](/docs/integrations/) for the interface every adapter shares.

## What it reads

Every request is a `GET` to your `STRAPI_URL`, through the same fetcher as every other request.

| Endpoint                             | Key             | What for                                                                                                                                                    |
| ------------------------------------ | --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/{collection}`              | read-only token | The published entries of a collection you named: counts, fingerprints and field counts. Pages of 100 (`pagination[page]`, `pagination[pageSize]`).          |
| `GET /api/{collection}?status=draft` | read-only token | A count of the draft list (Strapi 5), compared with the published count, for whether unpublished work is reachable. `publicationState=preview` on Strapi 4. |
| `GET /api/{collection}`, no token    | none            | Only with `--owner-consent`: what a visitor can list. See [the draft check](#the-two-checks).                                                               |

**Strapi does not list its collections to an API token** (the content-type routes belong to the admin panel, which Gaugeline never uses). So you name the collections to read, by their API ID (the plural name, such as `events`), as keys of `urls` or `fingerprint` in `gaugeline.adapters.json`. A collection you do not name is not read.

Single types (a homepage, a settings entry) answer one entry and are counted as one. Fields are read as Strapi sends them: scalar attributes (text, number, boolean, date, enumeration, JSON) are there; relations, media and components are not sent unless a request populates them, and Gaugeline sends no `populate`, so a field of that kind counts as missing. Strapi 5 rows are flat and carry a `documentId`, which is the id used here; Strapi 4 rows are wrapped in `attributes` and the numeric id is used. Ids, slugs and times only are kept: a name, a price or a paragraph is read to be counted or hashed and is never kept, printed or put in a finding.

Rate limits: when Strapi answers 429 with a short `Retry-After`, Gaugeline waits once and goes on; after that it keeps what it read and says the result is partial.

## Example: a neighbourhood bar on Strapi

Brass Anchor Taproom is an invented bar. A freelancer built its site with Next.js on a Strapi backend: events (one page each), menu items (one page each) and reviews (shown on the home page, with no pages of their own). The manager edits Strapi between shifts. The freelancer wants to know, before the manager does, which published events have no page, and whether the Public role was left open.

Settings go in `gaugeline.adapters.json` in the project folder. Nothing in it is a key. Only the collections you give an address pattern (`urls`) have their pages checked.

```json title=gaugeline.adapters.json
{
  "adapters": [
    {
      "id": "strapi",
      "fingerprint": { "events": ["title", "blurb"] },
      "urls": { "events": "/events/{slug}", "menu-items": "/menu/{slug}" }
    }
  ]
}
```

With `STRAPI_URL` and `STRAPI_TOKEN` in the environment, this is what the adapter reads over the bar's Strapi (invented: one event never published, and a Public role left open on events):

```json title=Output
{
  "types": [
    {
      "name": "events",
      "count": 2
    },
    {
      "name": "menu-items",
      "count": 2
    }
  ],
  "event fields": {
    "title": 2,
    "blurb": 1,
    "slug": 2,
    "seats": 0
  },
  "drafts reachable": true,
  "published events": [
    {
      "id": "evt-harvest",
      "type": "events",
      "url": "/events/harvest-beer-night",
      "slug": "harvest-beer-night",
      "publishedAt": "2026-10-20T09:00:00.000Z",
      "updatedAt": "2026-10-20T09:00:00.000Z",
      "fieldHashes": {
        "title": "22660b90571ac675",
        "blurb": "f91e7b31cb05e49c"
      }
    },
    {
      "id": "evt-quiz",
      "type": "events",
      "url": "/events/pub-quiz",
      "slug": "pub-quiz",
      "publishedAt": "2026-11-01T09:00:00.000Z",
      "updatedAt": "2026-11-01T09:00:00.000Z",
      "fieldHashes": {
        "title": "81a089c43efb14a0"
      }
    }
  ]
}
```

Read it the way the freelancer does. Events has two published entries, though Strapi holds three: the third was never published. `drafts reachable` is `true` because the token's draft list is longer than its published list. The quiz has no `blurb`, so it has no hash for it (a field an entry lacks is left out, never hashed as empty), and `seats` counts 0 because no entry has one. The hashes stand for the bar's titles and blurbs, which are not in the output.

The two checks then run over that site and its live pages, with the owner's consent for the second:

```json title=Findings
{
  "findings": [
    {
      "check": "strapi-entry-no-page",
      "severity": "high",
      "evidence": "events: pub-quiz is published in Strapi and /events/pub-quiz answers 404",
      "url": "https://brass-anchor.example/events/pub-quiz"
    },
    {
      "check": "strapi-drafts-public",
      "severity": "high",
      "evidence": "events: 1 entry that is not published can be listed with no token: evt-new-year",
      "url": "https://brass-anchor.example"
    }
  ],
  "could not check": [],
  "passed": []
}
```

- **`strapi-entry-no-page`**: the pub quiz is published in Strapi and the Next.js site has no page for it (a route that was not built, or a slug changed). A customer who follows the link the bar posted gets an error page.
- **`strapi-drafts-public`**: a visitor with no token can list a New Year's Eve event that was never published. The finding is a count and an id; the title is not shown. The fix is in Strapi's **Settings, Users & Permissions plugin, Roles, Public**: take `find` and `findOne` away from `events` and give the front end the read-only token.

## The two checks

Both are in the [checks reference](/docs/checks) with what they catch, why it matters, how to fix it and a technical line.

| Check                  | Severity | Finds                                                                                                         |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------- |
| `strapi-entry-no-page` | high     | A published entry whose address, from the pattern in the settings, answers 404 or 410 on the live site.       |
| `strapi-drafts-public` | high     | A collection whose entries that were never published can be listed by a visitor who sends no token (probing). |

**`strapi-drafts-public` is a probing check.** It asks Strapi's public routes for work the owner did not publish, so it is off unless you pass `--owner-consent` (or put the consent in `gaugeline.consent.json`), and it should be run only on sites you own or have permission to test. Without consent Gaugeline asks nothing of the draft routes and the check says it was not asked; it is never a pass. It sends no token (a visitor has none), looks at counts and ids only (`fields[0]=updatedAt`, so the answer carries no content), reads at most 500 ids from each list and subtracts the published ids from the draft ids in a set. A collection that answers 401, 403 or 404 to a visitor is private and passes; one that lists published entries and refuses the draft list passes. It sends no login, no form and no guess at an id.

The checks do not run from a command yet: like the other content checks they use the adapter as it arrives (`readStrapi` and `createStrapiRegistry` in Gaugeline's core).

## What cannot be checked

Anything the platform does not expose is could-not-check, with the reason, never a pass and never scraped from Strapi's admin:

| Question                                       | Answer here                          | Why                                                                                                |
| ---------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Which collections the site has                 | only the ones you name               | Listing content types belongs to the admin panel, not the REST API a token can use.                |
| Who has access to the admin (`members`)        | not offered                          | There is no members route for an API token.                                                        |
| Whether a page shows the same words as the CMS | not decided here                     | The adapter gives hashes; the comparison with the page is the published-but-not-live check (F-05). |
| A collection's page address                    | only from your `urls` settings       | The API does not say where the front end serves a collection, so Gaugeline does not guess.         |
| Relations, media and components                | counted as missing                   | They are not sent without `populate`, and Gaugeline sends none.                                    |
| Other locales                                  | not read                             | Only the default locale is.                                                                        |
| A collection the token may not read            | could not check, for that collection | The others are still read.                                                                         |
| GraphQL                                        | not used                             | Its queries are `POST` requests, which wait for ADR-0006.                                          |

## When it cannot check

It never returns a list with a hole in it. The read is could-not-check, with the reason in plain words, when:

- `STRAPI_URL` is not set, is not an address, has a user name or password in it, or is `http` while a token is set (the token is not sent over plain http);
- `STRAPI_TOKEN` is not set and the question is about unpublished work, or Strapi does not accept it (HTTP 401), or the token may not read the collection (HTTP 403: its permissions need `find` and `findOne`);
- a name under `urls` or `fingerprint` is not a collection API ID, or Strapi has no such collection (HTTP 404), or no collection is named at all;
- an answer is not the shape Strapi sends, an entry has no id or no update time, a collection is bigger than the bound, a page is too big even at 10 entries, or the list stops before its total;
- a collection has published entries and no `urls` pattern, or an entry has no slug for the pattern (its pages were not checked), or a live page answers anything but a page or a 404 or 410 (a 503, a login, a timeout), in which case that one page is could-not-check.

## What is bounded

| Limit                                      | Value  |
| ------------------------------------------ | ------ |
| Entries in one page of a list              | 100    |
| Entries read from one collection           | 10,000 |
| Ids read from each list by the draft check | 500    |
| Live pages asked for in one run            | 300    |

There are no flags to raise them. A page beyond the budget is could-not-check, named in the result, not skipped quietly. An address pattern that points at another site is not asked.

## Settings

| `gaugeline.adapters.json` field | What it does                                                                                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapters[].id`                 | `strapi`.                                                                                                                                                        |
| `adapters[].fingerprint`        | Fields to hash, by collection API ID. Up to 20 per collection. Naming a collection here also means it is read.                                                   |
| `adapters[].urls`               | Where a collection's pages live: a path or an https address on the site. Only `{slug}` and `{id}` are filled in. Naming a collection here also means it is read. |

| Environment variable | What it is                                                          |
| -------------------- | ------------------------------------------------------------------- |
| `STRAPI_URL`         | The Strapi address, such as `https://cms.client.example`. Required. |
| `STRAPI_TOKEN`       | A Read-only API token. Needed for unpublished work; see above.      |

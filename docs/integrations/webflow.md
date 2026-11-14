# Webflow: content checks for sites built on Webflow

What a Webflow site's CMS says is published, against what the live site shows. A read-only token, and nothing is ever written.

**The key first.** Webflow can make a token that only reads. A site token lets you pick its scopes one by one, and Gaugeline asks for exactly two, `sites:read` and `cms:read`, both read-only. With those a token can list the site, its collections and their items, and it cannot change, publish or delete anything. Gaugeline's key kind for Webflow is `read-only`.

This page lists the endpoints the adapter uses, how to make the token, a worked example for a freelancer's client, what the two Webflow checks find, and what Gaugeline will not do. See [Content systems](/docs/integrations/) for the interface every adapter shares.

**A note on sources.** Webflow's own documentation could not be reached when this page was written (the build session's network policy refused `developers.webflow.com`). The endpoint paths, the answer shapes, the scope names and the rate limits below are from the build's knowledge of the Data API v2, and each is pinned by Gaugeline's tests over invented answers, not confirmed against the live pages. Check them against the current [Webflow Data API reference](https://developers.webflow.com/data/reference) before relying on a detail. [docs]

## Make the token

1. In Webflow, open the site's **Site settings**, then **Apps & integrations**, then **API access**.
2. Choose **Generate API token**, name it (`Gaugeline, read only`), give it **Read** access to **Sites** (`sites:read`) and **CMS** (`cms:read`), and nothing else.
3. Put it in the environment where Gaugeline runs, never in a file you commit:

```text
WEBFLOW_TOKEN=<the token>
WEBFLOW_SITE_ID=<the site's id, from Site settings>
```

`WEBFLOW_SITE_ID` is optional. A site token can see one site, so with `sites:read` Gaugeline finds it. If the token sees more than one site, or has no `sites:read`, Gaugeline says so and asks for the id; it never guesses. The token goes in an `Authorization` header and never in an address, and every message, finding and report has it blanked.

## What it reads

Every request is a `GET` to `https://api.webflow.com/v2`, through the same fetcher as every other request. Nothing else is ever sent.

| Endpoint                                         | Scope        | What for                                                                                                                                                                             |
| ------------------------------------------------ | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET /v2/sites`                                  | `sites:read` | Finding the site, only when `WEBFLOW_SITE_ID` is not set. [Reference](https://developers.webflow.com/data/reference/sites/list)                                                      |
| `GET /v2/sites/{site_id}/collections`            | `cms:read`   | The site's collections, with their slugs. [Reference](https://developers.webflow.com/data/reference/cms/collections/list)                                                            |
| `GET /v2/collections/{collection_id}/items/live` | `cms:read`   | The published items: counts, fingerprints and field counts. [Reference](https://developers.webflow.com/data/reference/cms/collection-items/live-items/list-items-live)               |
| `GET /v2/collections/{collection_id}/items`      | `cms:read`   | Every item, staged and drafts included, for what is waiting to be published. [Reference](https://developers.webflow.com/data/reference/cms/collection-items/staged-items/list-items) |

Items are read 100 at a time, the API's own maximum, until the total the API reports has been read. A page of long posts can be bigger than the 5 MB Gaugeline reads from one answer: that page is asked again with half as many items, down to 10, and only if even 10 are too big is the collection could-not-check, with the reason. A page that comes back short is not taken for the end of the list, and one that comes back empty before the total is could-not-check. A collection with more than 10,000 items is could-not-check for field counts, never a count of part of it. Rate limits depend on the account's plan; when Webflow answers 429 with a short `Retry-After`, Gaugeline waits once and goes on, and after that it keeps what it read and says the result is partial ([rate limits](https://developers.webflow.com/data/reference/rate-limits)).

The adapter reads the primary language of a localised site. It does not read other locales.

### What reaches your computer

Webflow's list endpoints send each item's field data with it, and there is no parameter that leaves it out. So the field values arrive in the answer. They are used for exactly two things: counting which items have a field (`fieldCounts`) and hashing the fields the settings name (`fingerprint`). The adapter keeps no value, and nothing but the short hash is printed, logged or put in a finding or report. The run's fetcher, however, remembers every answer it received until the run ends (so an address is not asked twice), and that includes the field data of the items read; it is held in the memory of the process and is never written anywhere. A finding names the collection, the item's slug and the dates; it never shows a name, a price or a paragraph of the client's. With no `fingerprint` in the settings, nothing is hashed at all.

## Example: a pop-up dinner club on Webflow

Saltmarsh Supper Club is an invented pop-up dinner club. A freelancer built its site on Webflow: a CMS of events (one page each), menu items (one page each) and testimonials (shown on the home page, with no pages of their own). The owner edits the CMS between services and publishes from her phone. The freelancer wants to know, before the owner does, what she has saved and not published, and which events have no page.

Settings go in `gaugeline.adapters.json` in the project folder. Nothing in it is a key. Only the collections you give an address pattern (`urls`) have their pages checked. Here testimonials has none, so the page check lists it under "could not check" instead of guessing where its pages are, and passes nothing for it.

```json title=gaugeline.adapters.json
{
  "adapters": [
    {
      "id": "webflow",
      "fingerprint": { "events": ["name", "summary"] },
      "urls": { "events": "/events/{slug}", "menu-items": "/menu/{slug}" }
    }
  ]
}
```

With `WEBFLOW_TOKEN` and `WEBFLOW_SITE_ID` in the environment, this is what the adapter reads over her site (invented: one event staged and never published, one draft, one archived, and a menu item edited after it was last published):

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
    },
    {
      "name": "testimonials",
      "count": 2
    }
  ],
  "event fields": {
    "name": 2,
    "summary": 1,
    "seats": 2
  },
  "drafts reachable": true,
  "published events": [
    {
      "id": "e-harvest",
      "type": "events",
      "url": "/events/harvest-table",
      "slug": "harvest-table",
      "publishedAt": "2026-10-28T09:00:00.000Z",
      "updatedAt": "2026-10-28T08:55:00.000Z",
      "fieldHashes": {
        "name": "fe923c34dcec4bc5",
        "summary": "a993d16f933000a4"
      }
    },
    {
      "id": "e-oyster",
      "type": "events",
      "url": "/events/oyster-night",
      "slug": "oyster-night",
      "publishedAt": "2026-11-02T09:00:00.000Z",
      "updatedAt": "2026-11-02T08:50:00.000Z",
      "fieldHashes": {
        "name": "0843193773b122f1"
      }
    }
  ]
}
```

Read it the way the freelancer does. Events has two published items, though the CMS holds five: the other three (a staged event, a draft and an archived one) are not live. `drafts reachable` is `true` because the staged list holds items the live list does not. The oyster night has no `summary`, so it has no hash for it (a field an item lacks is left out, never hashed as empty). The hashes stand for her names and summaries, which are not in the output.

The two checks then run over that site and its live pages. Each published item with an address pattern costs one `GET` of its page on the live site:

```json title=Findings
{
  "findings": [
    {
      "check": "webflow-item-no-page",
      "severity": "high",
      "evidence": "events: oyster-night is published in the CMS and /events/oyster-night answers 404",
      "url": "https://saltmarsh-supper.example/events/oyster-night"
    },
    {
      "check": "webflow-item-staged",
      "severity": "medium",
      "evidence": "events: winter-warmer is saved and has never been published (last saved 2026-11-08)",
      "url": "https://saltmarsh-supper.example/events/winter-warmer"
    },
    {
      "check": "webflow-item-staged",
      "severity": "medium",
      "evidence": "menu-items: smoked-trout was saved on 2026-11-09 after it was last published on 2026-10-20",
      "url": "https://saltmarsh-supper.example/menu/smoked-trout"
    }
  ],
  "could not check": [
    {
      "id": "webflow-item-no-page",
      "reason": "testimonials: its pages were not checked. It has published items and no address pattern in gaugeline.adapters.json (urls), and Gaugeline will not guess where a collection's pages are. If it has no pages of its own, this is expected.",
      "url": "https://saltmarsh-supper.example"
    }
  ],
  "passed": []
}
```

- **`webflow-item-no-page`** (high): the oyster night is published in the CMS and `/events/oyster-night` answers 404. A customer who follows the link she sent gets an error page.
- **`webflow-item-staged`** (medium), twice: the winter warmer was saved as ready and has never been published, and the smoked trout was edited on 9 November after it was last published on 20 October, so the live menu still has the old version.
- The draft (the New Year feast) and the archived summer supper are not findings. A draft is not published on purpose, and an archived item is taken down on purpose.

The testimonials are the one "could not check": they have published items and no pattern, so Gaugeline does not know where their pages are. The freelancer knows they are shown on the home page and have no pages, so this line is expected; adding a pattern would turn it into a check. Nothing of her names, summaries or prices is in a finding: a finding names the collection, the item's slug and dates.

## The two checks

Both are in the [checks reference](/docs/checks) with what they catch, why it matters, how to fix it and a technical line.

| Check                  | Severity | Finds                                                                                                  |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `webflow-item-staged`  | medium   | An item saved as ready (not a draft) that was never published, or edited after it was last published.  |
| `webflow-item-no-page` | high     | A published item whose address, from the pattern in the settings, answers 404 or 410 on the live site. |

How an item's state is decided, from the staged list alone: archived items and drafts are left out; a ready item with no `lastPublished` is **staged**; one whose `lastUpdated` is more than 2 seconds later than its `lastPublished` is **changed** (the platform may stamp the edit a moment after the publish, and that is not a change); anything else is live. A published item in a collection with a pattern that has no slug, or a slug the pattern cannot turn into an address, is could-not-check by name, not skipped. A staged finding's address is shown only when it is on the checked site. The checks do not run from a command yet: like the other content checks they use the adapter as it arrives (`readWebflow` and `createWebflowRegistry` in Gaugeline's core), and the published-but-not-live check (F-05) will run them from the command line.

## What cannot be checked

Anything the platform does not expose is could-not-check, with the reason, never a pass and never scraped from Webflow's designer or dashboard:

| Question                                       | Answer here                          | Why                                                                                                |
| ---------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Who has access to the site (`members`)         | not offered                          | The Data API has no members list for a site token.                                                 |
| Whether a page shows the same words as the CMS | not decided here                     | The adapter gives hashes; the comparison with the page is the published-but-not-live check (F-05). |
| A collection's page address                    | only from your `urls` settings       | The API does not say where a collection's template page lives, so Gaugeline does not guess.        |
| Items in other languages                       | not read                             | Only the primary language is.                                                                      |
| A collection the token may not read            | could not check, for that collection | The others are still read.                                                                         |
| A token without `cms:read`                     | could not check, naming the scope    | Never an empty result.                                                                             |

## When it cannot check

It never returns a list with a hole in it. The read is could-not-check, with the reason in plain words, when:

- `WEBFLOW_TOKEN` is not set (nothing is asked), or Webflow does not accept it (HTTP 401);
- the token lacks a scope (HTTP 403): `sites:read` for finding the site, `cms:read` for everything else;
- the token sees more than one site and `WEBFLOW_SITE_ID` is not set, or the site id is not one Webflow knows (HTTP 404);
- an answer is not the shape Webflow sends, or an item has no id or no update time;
- a collection is bigger than the bound, a page of items is too big even at 10 items, or the list stops before its total; a collection has published items and no `urls` pattern, or an item has no slug for the pattern (its pages were not checked); or a live page answers anything but a page or a 404 or 410 (a 503, a login, a timeout), in which case that one page is could-not-check.

A site that asks Gaugeline to slow down (HTTP 429) is waited for once when it says how long and the wait is a minute or less; after that the run keeps what it had read and says it is partial, and neither check passes.

## What is bounded

| Limit                           | Value  |
| ------------------------------- | ------ |
| Items in one page of a list     | 100    |
| Items read from one collection  | 10,000 |
| Live pages asked for in one run | 300    |

There are no flags to raise them. A page beyond the budget is could-not-check, named in the result, not skipped quietly. An address pattern that points at another site is not asked.

## Settings

| `gaugeline.adapters.json` field | What it does                                                                                                                                                                                                           |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapters[].id`                 | `webflow`.                                                                                                                                                                                                             |
| `adapters[].fingerprint`        | Fields to hash, by collection slug, by Webflow's own field names (`post-body`, `summary`). Up to 20 per collection.                                                                                                    |
| `adapters[].urls`               | Where a collection's pages live: a path or an https address on the site. Only `{slug}` and `{id}` are filled in. A collection with no entry has its pages left out of the page check and is listed as could not check. |

| Environment variable | What it is                                                    |
| -------------------- | ------------------------------------------------------------- |
| `WEBFLOW_TOKEN`      | The site token with `sites:read` and `cms:read`. Required.    |
| `WEBFLOW_SITE_ID`    | The site's id. Optional when the token sees exactly one site. |

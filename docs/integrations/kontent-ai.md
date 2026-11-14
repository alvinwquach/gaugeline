# Kontent.ai: content checks for sites built on Kontent.ai

What a Kontent.ai environment says is published, against what the live site shows, and whether an item that was never published still has a page. Gaugeline only reads, through Kontent.ai's Delivery API, with no key for a public project and the narrowest key Kontent.ai offers for a secured one.

## What this adapter reads, and the narrowest key

**The key first.** Kontent.ai's Delivery API answers for published content only. A project that has not turned on secure access needs **no key at all** to read it, and Gaugeline sends none. A project with secure access on needs a **Delivery API secure access key**, which a program sends in an `Authorization: Bearer` header [docs]; that key can only read published content, so Gaugeline's key kind for Kontent.ai is `read-only`. The Preview API is a different host (`preview-deliver.kontent.ai`) with its own **Preview API key**, which reads unpublished content too [docs]; the two keys cannot be used in one request [docs]. Gaugeline uses the Preview API key for one thing only, the probing check below, and sends it to the Preview host and nowhere else.

This page lists what the adapter reads, a worked example for a freelancer's client, what the check finds, what could not be checked and why, and what Gaugeline will not do. See [Content systems](/docs/integrations/) for the interface every adapter shares.

**A note on sources.** Documentation checked on: 2026-11-12. Kontent.ai's own documentation site (kontent.ai/learn) could not be reached when this page was written, so no page of it was opened. What is cited [docs] comes from the vendor's published npm package `@kontent-ai/delivery-sdk` 16.4.8 (MIT licence): its source and README, read on that date. From it: the two hosts `deliver.kontent.ai` and `preview-deliver.kontent.ai`, the address shape `https://deliver.kontent.ai/ENVIRONMENT_ID/items`, the `Authorization: Bearer KEY` header for both the secure access key and the Preview API key, the rule that preview and secured modes cannot be used at the same time, the parameters `limit`, `skip`, `order` (as in `order=system.codename[asc]`), `includeTotalCount=true` and `elements`, the `pagination` object (`skip`, `limit`, `count`, `next_page`, `total_count`), the `system` fields (`id`, `name`, `codename`, `type`, `last_modified`, `language`, `sitemap_locations`, `collection`, `workflow`, `workflow_step`), that the Preview API returns unpublished and archived items, and the `archived` workflow step. What is **uncited**: that an environment id is a UUID (the examples in the package are), the largest `limit` the API accepts (Gaugeline asks for 100), that the `published` step's codename is `published` in every workflow, that the Delivery API lists only the default language without a `language` parameter, what status a project with secure access answers a request with no key (the adapter treats 401 and 403 alike), the rate-limit headers, and that `skip` stays exact for a list being edited. Check this page against Kontent.ai's current documentation before relying on a detail.

## What it reads

Every request is a `GET` through Gaugeline's fetcher, to one of two fixed hosts. Nothing from the environment or from an answer chooses a host.

| Endpoint                                                        | What for                                                                                                                                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GET https://deliver.kontent.ai/{environment id}/items`         | The published items: counts, fingerprints and field counts. With the secure access key in `Authorization: Bearer` when `KONTENT_SECURE_ACCESS_KEY` is set, with no key otherwise.    |
| `GET https://preview-deliver.kontent.ai/{environment id}/items` | Only with `--owner-consent` and `readPreview`: which items are not published. Asks for ids, types, workflow steps and the slug element only. With `KONTENT_PREVIEW_API_KEY`, Bearer. |

A list is read in pages of 100 items, in a fixed order (`order=system.codename[asc]`: a codename is unique in an environment), with `includeTotalCount=true`. The next page is asked for with `skip`, stepping by the number of items that came back. Each page must echo the `skip` that was asked, must count its own items correctly, and must report the same `total_count` as the page before; the list ends when exactly `total_count` items have been read, each id seen once. A list that stops early, repeats an item, grows or shrinks while it is read, has a `next_page` after the last item, or is longer than the bound is could-not-check, never a count of part of it. A page that is too big for Gaugeline's size limit is asked again with half as many items, down to 5. When Kontent.ai answers 429 with a short `Retry-After`, Gaugeline waits once and goes on; after that it keeps what it read and says the result is partial. A redirect is never followed, so a key goes to the address that was asked and nowhere else.

Gaugeline asks for the default language only (it sends no `language` parameter), and does not ask Kontent.ai to list its content types: the types are the ones the items have.

## Make the key

For a public project there is nothing to make. Put the environment id, from Environment settings, API keys in Kontent.ai, in the environment where Gaugeline runs:

```text
KONTENT_ENVIRONMENT_ID=5f1d2c7e-3b8a-4c1e-9d46-7a2b8e0f1c35
```

If secure access is on for the environment, make a Delivery API secure access key in the same place and add it. It goes in an `Authorization: Bearer` header and never in an address:

```text
KONTENT_SECURE_ACCESS_KEY=the secure access key
```

Only for the probing check, make a **Preview API key** for the run and add it. Treat it as more powerful than the others, because it reads drafts. Never put any of these in a file you commit.

```text
KONTENT_PREVIEW_API_KEY=the Preview API key
```

Each key is sent only to its own host, only over https, and only when it is a plain key (no space, line break or character outside ASCII). Every message, finding and report has them blanked.

### What reaches your computer

Gaugeline asks for exactly the elements it needs: the slug element (`url` unless you set `slugElement`) and the elements you list under `fingerprint`. Element values are used for exactly two things: counting which items have an element (an empty element does not count) and hashing the elements the settings name. The adapter keeps no value, and nothing but the short hash is printed, logged or put in a finding or report. With no `fingerprint` in the settings, no element value is read except the slug. The preview read asks for ids, types, steps and slugs only.

## Example: a bike shop on Kontent.ai

Fernhill Cycles is an invented bike shop and repair workshop. A freelancer built its site on Kontent.ai and Next.js: journal articles (spring service, winter opening hours) and offers (an e-bike trial week). The owner is putting a closing-down sale together and has saved it as a draft; it is not for sale until she says so. The freelancer's front end has a preview route, and he wants to be sure the live build reads the Delivery API only. For that question he makes a Preview API key, sets `readPreview`, and runs with `--owner-consent` on his client's project.

Settings go in `gaugeline.adapters.json` in the project folder. Nothing in it is a key.

```json title=gaugeline.adapters.json
{
  "adapters": [
    {
      "id": "kontent-ai",
      "fingerprint": {
        "article": ["title", "summary"]
      },
      "urls": {
        "article": "/journal/{slug}",
        "offer": "/offers/{slug}"
      },
      "readPreview": true
    }
  ]
}
```

What the adapter reads over that project, with a live site that has a page the closing-down sale should not have (a test compares this output with the tool, so it cannot drift). The `preview read` and `findings` lines are what the check reads when you pass `--owner-consent` and set `readPreview`; without them nothing is asked of the Preview API:

```json title=Output
{
  "types": [
    {
      "name": "article",
      "count": 2
    },
    {
      "name": "offer",
      "count": 1
    }
  ],
  "article fields": {
    "title": 2,
    "summary": 1,
    "subtitle": 0
  },
  "drafts reachable": "not-applicable",
  "published articles": [
    {
      "id": "00000000-0000-4000-8000-000000000001",
      "type": "article",
      "url": "/journal/spring-service",
      "slug": "spring-service",
      "updatedAt": "2026-11-02T10:00:00.123Z",
      "fieldHashes": {
        "title": "86c079fbbb157099",
        "summary": "e9ff0e1f0155ae93"
      }
    },
    {
      "id": "00000000-0000-4000-8000-000000000002",
      "type": "article",
      "url": "/journal/winter-hours",
      "slug": "winter-hours",
      "updatedAt": "2026-10-02T10:00:00.000Z",
      "fieldHashes": {
        "title": "b9c6da97f6d0c608"
      }
    }
  ]
}
```

```json title=Findings
{
  "preview read": {
    "state": "read",
    "published": 3,
    "not published": [
      "article: closing-sale (draft)",
      "article: price-list-2025 (archived)",
      "offer: spring-ride-out (scheduled)"
    ]
  },
  "findings": [
    {
      "check": "kontent-ai-unpublished-live",
      "severity": "high",
      "evidence": "article: closing-sale is in the workflow step draft in Kontent.ai, not published, and /journal/closing-sale answers 200 on the live site",
      "url": "https://fernhill-cycles.example/journal/closing-sale"
    }
  ],
  "could not check": [],
  "passed": []
}
```

Read it the way the freelancer does. The published list has two articles and an offer, and each article has an address the live site should answer. The winter hours article has no summary, so its `summary` hash is missing rather than hashed as empty. The Preview API lists three items the Delivery API does not: a draft, an archived price list and a scheduled ride-out. The important line is the finding: the live site answers 200 at `/journal/closing-sale`, so the front end is building pages from the Preview API, and anyone who finds the address can read the sale before it is announced. The other two answered 404, which is what a live site should do. The freelancer switches the live build to the Delivery API and revalidates.

The text of the client's items never appears in a report: only counts, ids, slugs, steps, dates and short hashes.

## The check

| Check                         | Severity | Needs                                                             | What it finds                                                                                                                              |
| ----------------------------- | -------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `kontent-ai-unpublished-live` | high     | `--owner-consent`, `readPreview: true`, a Preview API key, `urls` | An item the Preview API lists and the Delivery API does not, in a workflow step other than published, whose page answers on the live site. |

**`kontent-ai-unpublished-live` is a probing check.** It asks the Preview API for unpublished items with the key you gave Gaugeline, so it is off unless you pass `--owner-consent` (or put the consent in `gaugeline.consent.json`) **and** set `readPreview: true`, and you should run it only on sites you own or have permission to test. Without consent the report lists it under could-not-check with "not asked", never as a pass. Active testing of a site is outside what Gaugeline does: the check reads the CMS you gave it a key for, and asks the live site for each page with one `GET`.

**It needs a Preview API key.** Without one the check says could-not-check ("KONTENT_PREVIEW_API_KEY is not set"). A key the Preview API refuses (HTTP 401 or 403) is the same: Gaugeline does not know which items are unpublished, and not knowing is not a pass.

How it decides. The Delivery list is read first and its ids are held in a Set; then the Preview list, which holds every published item and the unpublished ones. A Preview list that lacks an item the Delivery list has is not the Preview list, and is could-not-check. The unpublished items are the ids only the Preview list has. An item only the Preview list has whose workflow step says `published`, or is not a plain codename, was most likely published a moment ago: it is counted and named as could-not-check, never reported. An item that has a published version and a newer draft in review is in both lists and is not unpublished: the live page is the published version. If anything is left, the Delivery list is read once more (asked again, not served from memory), and a list that changed in between is could-not-check. Each unpublished item's address comes from the `urls` pattern for its type and its slug; an item with no pattern, no slug, or the same slug as a published item of its type (a live page there would be the published one) is could-not-check for that item. Then one `GET` of that page on the checked site's own host, at most 40 pages a run (the rest are could-not-check). A final 2xx answer is the finding, 404 or 410 passes for that item, and any other answer is could-not-check for that page. A page that answers through a redirect to another path is could-not-check, not a finding; a redirect that only adds or removes a trailing slash is the same page. A finding shows the type, the item's slug or id, its workflow step, the path and the status, never an element.

## What cannot be checked

Anything the platform does not expose is could-not-check, with the reason, never a pass and never scraped from the platform's admin screens:

| Question                            | Answer here      | Why                                                                                                                                 |
| ----------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| The list of content types           | not offered      | The types are the ones the published items have. A type with no published item has nothing to count.                                |
| Who has access to the environment   | not offered      | Members are managed through the Management API, which Gaugeline does not call.                                                      |
| Whether a page shows the same words | not decided here | The adapter gives hashes; comparing them with the page is another check.                                                            |
| Items in other languages            | not read         | The adapter asks with no `language` parameter, so the default language is read. `uncited`                                           |
| Items in a language fallback        | not told apart   | An item that falls back to the default language is listed as the default language's. `uncited`                                      |
| A scheduled item                    | read by step     | An item scheduled to publish is in a step before published until then, and shows as unpublished.                                    |
| An element that does not exist      | counts 0         | An element a type does not have is not an error in the answer, so a mistyped element in `fingerprint` counts 0 and is never hashed. |

## When it cannot check

It never returns a list with a hole in it. The read is could-not-check, with the reason in plain words, when:

- `KONTENT_ENVIRONMENT_ID` is not set or is not a UUID (nothing is asked and no key is sent);
- a key has a space, a line break or a character outside plain ASCII (nothing is asked);
- a project with secure access is asked with no key, or Kontent.ai does not accept the key (HTTP 401 or 403): the messages are not repeated, because they can quote content;
- an element named under `fingerprint` or `slugElement` is not an element codename (lower-case letters, digits and underscores; nothing is asked);
- an answer is not the shape the platform sends, an item has no id or no type, or (for fingerprints) no readable update time;
- the list is bigger than the bound, a page is too big even at 5 items, a total moves, an item is listed twice, or the list stops before its total;
- Kontent.ai answers with a redirect, which is not followed.

A platform that asks Gaugeline to slow down (HTTP 429) is waited for once when it says how long and the wait is a minute or less; after that the run keeps what it had read and says it is partial.

## What is bounded

| Limit                                 | Value  |
| ------------------------------------- | ------ |
| Items in one page of a list           | 100    |
| Items read from one list              | 10,000 |
| Pages of the live site asked in a run | 40     |

There are no flags to raise them.

## Settings

| `gaugeline.adapters.json` field | What it does                                                                                                            |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `adapters[].id`                 | `kontent-ai`.                                                                                                           |
| `adapters[].fingerprint`        | Elements to hash, by content type codename. A name is an element codename: lower-case letters, digits, underscores.     |
| `adapters[].urls`               | Where a type's pages live: a path or an https address. Only `{slug}` and `{id}` are filled in.                          |
| `adapters[].slugElement`        | The codename of the element that holds an item's slug. Default: `url`.                                                  |
| `adapters[].readPreview`        | Lets `kontent-ai-unpublished-live` read the Preview API (ids, types, steps and slugs). It also needs `--owner-consent`. |

| Environment variable        | What it is                                                                                              |
| --------------------------- | ------------------------------------------------------------------------------------------------------- |
| `KONTENT_ENVIRONMENT_ID`    | The environment's id (a UUID). Not a key.                                                               |
| `KONTENT_SECURE_ACCESS_KEY` | A Delivery API secure access key. Only for an environment with secure access on. Sent as a header only. |
| `KONTENT_PREVIEW_API_KEY`   | A Preview API key. Only for the probing check. Sent as a header only, to the Preview host only.         |

## A recipe for the same project

If you would rather not use the native adapter, [the Kontent.ai recipe](/docs/integrations/recipes/#kontent-ai) reads the same Delivery API through the [generic API adapter](/docs/integrations/generic-api). It has no preview check, and it hashes each element's whole object (`{ value }` and, in the real API, its type and name), so its hashes differ from this adapter's, which hash the element's value. The native adapter passes the recipe's recorded-response test for types, field counts and fingerprints, with that one difference.

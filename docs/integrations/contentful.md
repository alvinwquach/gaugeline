# Contentful: content checks for sites built on Contentful

What a Contentful space says is published, against what the live site shows. A delivery token that can only read, and nothing is ever written.

## What this adapter reads, and the narrowest key

**The key first.** The narrowest key is a Content Delivery API access token (a "delivery token"). It is read-only by design: the Content Delivery API serves published entries and assets and has no endpoint that creates, changes or deletes anything. It is also limited to one space and to the environments you enable it for. Gaugeline's key kind for Contentful is `read-only`. Gaugeline never asks for a Content Management token (the kind that starts `CFPAT-` and can edit the space), and it never needs one.

**What it reads.** Every request is a `GET` to `https://cdn.contentful.com/spaces/{space_id}/environments/{environment_id}`, through the same fetcher as every other request, with the token in an `Authorization: Bearer` header. Contentful also accepts the token as an `access_token` address parameter. Gaugeline never uses that form: a key in an address ends up in logs and browser history. The header is sent to `cdn.contentful.com` only, and a redirect to any other origin is followed without it. If you set a Preview API token (below), it goes to `preview.contentful.com` only.

**A note on sources.** Contentful's documentation could not be reached when this page was written (the build session's network policy refused `www.contentful.com`). The endpoint paths, answer shapes and header names below come from the type definitions and source of the official `contentful` package (version 11.5.0, from the npm registry: the `Bearer` header, the `sys` and `ContentType` shapes, `select`, and the `x-contentful-ratelimit-reset` header) and from the build's knowledge of the API. Each is pinned by Gaugeline's tests over invented answers, not confirmed against the live pages. Check them against the current [Content Delivery API reference](https://www.contentful.com/developers/docs/references/content-delivery-api/) and [authentication reference](https://www.contentful.com/developers/docs/references/authentication/) before relying on a detail. [docs] Anything below marked "uncited" is from memory.

This page lists the endpoints, how to make the token, a worked example for a bar's freelancer, what the check finds, the extra check for a preview token in your site's JavaScript, and what Gaugeline will not do. See [Content systems](/docs/integrations/) for the interface every adapter shares.

## Make the token

1. In Contentful, open **Settings**, then **API keys**, and choose **Add API key**.
2. Name it (`Gaugeline, read only`) and enable it for the environment you want read (`master` unless you use others). Copy the **Content Delivery API - access token**. Leave the Content Preview token alone unless you want the draft check below.
3. Put it in the environment where Gaugeline runs, never in a file you commit:

```text
CONTENTFUL_SPACE_ID=<the space id, shown in the API key's page>
CONTENTFUL_DELIVERY_TOKEN=<the Content Delivery API access token>
CONTENTFUL_ENVIRONMENT=<optional: master by default>
CONTENTFUL_PREVIEW_TOKEN=<optional: the Content Preview API access token>
```

Every message, finding and report has the tokens blanked. A token the space does not accept (HTTP 401), or one not enabled for the environment (HTTP 404), is could-not-check with a reason in plain words, never an empty result.

`CONTENTFUL_PREVIEW_TOKEN` is optional and used for one question only: are there entries saved and not published? With it, Gaugeline compares the number of entries the Preview API serves with the number the Delivery API serves, per content type, and nothing else is read from the Preview API (no entry, no field). Without it the question is answered "no": the delivery token cannot reach unpublished work. A preview token the space refuses makes only that answer could-not-check; the published reads still work.

## What it reads

| Endpoint                                                                                    | What for                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /spaces/{space_id}/environments/{environment_id}/content_types`                        | The content types, with the ids of their fields. [Reference](https://www.contentful.com/developers/docs/references/content-delivery-api/#/reference/content-types)                            |
| `GET /spaces/{space_id}/environments/{environment_id}/entries?content_type={id}&select=...` | The published entries of one content type: counts, fingerprints and field counts. [Reference](https://www.contentful.com/developers/docs/references/content-delivery-api/#/reference/entries) |

Entries are read 100 at a time (`limit`, with `skip`, ordered by `sys.createdAt` so pages do not shift) until the `total` the API reports has been read. `select` asks for the `sys` part and only the fields the settings name, plus `slug` when the content type has one. A field the content type does not have is never asked for. A page of long entries can be bigger than the 5 MB Gaugeline reads from one answer: that page is asked again with half as many entries, down to 10, and only if even 10 are too big is the content type could-not-check. A content type with more than 10,000 entries is could-not-check, never a count of part of it. When Contentful answers 429 with a short `X-Contentful-RateLimit-Reset` (or `Retry-After`), Gaugeline waits once and goes on; after that it keeps what it read and says the result is partial.

The adapter reads the default locale. It does not read other locales, and it does not follow linked entries or assets.

### What reaches your computer

Contentful's list endpoint sends the fields you `select` with each entry. They are used for exactly two things: counting which entries have a field (`fieldCounts`) and hashing the fields the settings name (`fingerprint`). The adapter keeps no value, and nothing but the short hash is printed, logged or put in a finding or report. The run's fetcher remembers every answer it received until the run ends (so an address is not asked twice), and that includes the selected fields of the entries read; it is held in the memory of the process and never written anywhere. A finding names the content type, the entry's slug and the status; it never shows a title or a paragraph of the client's. With no `fingerprint` in the settings, no field except `slug` is asked for at all.

## Example: a neighbourhood bar on Contentful and Next.js

Ash & Ember Taproom is an invented neighbourhood bar. A freelancer built its site on Next.js with Contentful: a tap list (one page per beer), events (one page each) and testimonials (shown on the home page, with no pages of their own). The Next.js pages are built when the owner publishes in Contentful, through a webhook to the host. The freelancer wants to know when that webhook has quietly failed, so a published event has no page.

Settings go in `gaugeline.adapters.json` in the project folder. Nothing in it is a key. Only the content types you give an address pattern (`urls`) have their pages checked. Here testimonials has none, so the check lists it under "could not check" instead of guessing where its pages are.

```json title=gaugeline.adapters.json
{
  "adapters": [
    {
      "id": "contentful",
      "fingerprint": { "event": ["title", "summary"] },
      "urls": { "beer": "/beers/{slug}", "event": "/events/{slug}" }
    }
  ]
}
```

With the three variables in the environment, this is what the adapter reads over the bar's space (invented):

```json title=Output
{
  "types": [
    {
      "name": "beer",
      "count": 3
    },
    {
      "name": "event",
      "count": 2
    },
    {
      "name": "testimonial",
      "count": 2
    }
  ],
  "event fields": {
    "title": 2,
    "summary": 1,
    "slug": 2
  },
  "drafts reachable": false,
  "published events": [
    {
      "id": "ev-trivia",
      "type": "event",
      "url": "/events/quiz-night",
      "slug": "quiz-night",
      "updatedAt": "2026-10-20T09:00:00.000Z",
      "fieldHashes": {
        "title": "148bfe22f4dd9519",
        "summary": "ca14c466bfc8105e"
      }
    },
    {
      "id": "ev-dinner",
      "type": "event",
      "url": "/events/brewers-dinner",
      "slug": "brewers-dinner",
      "updatedAt": "2026-11-02T09:00:00.000Z",
      "fieldHashes": {
        "title": "4a6b3047c96af41d"
      }
    }
  ]
}
```

Read it the way the freelancer does. The brewers' dinner has no `summary`, so it has no hash for it (a field an entry lacks is left out, never hashed as empty). `drafts reachable` is `false` because there is no preview token: the delivery token cannot see the New Year's Eve event the owner saved and has not published. The hashes stand for her titles and summaries, which are not in the output. `updatedAt` is the time of the published version, as the Delivery API gives it; it does not give a separate publish date, so there is no `publishedAt`.

The check then runs over that space and its live pages. Each published entry with an address pattern costs one `GET` of its page on the live site:

```json title=Findings
{
  "findings": [
    {
      "check": "contentful-entry-no-page",
      "severity": "high",
      "evidence": "event: brewers-dinner is published in Contentful and /events/brewers-dinner answers 404",
      "url": "https://ash-and-ember.example/events/brewers-dinner"
    }
  ],
  "could not check": [
    {
      "id": "contentful-entry-no-page",
      "reason": "testimonial: its pages were not checked. It has published entries and no address pattern in gaugeline.adapters.json (urls), and Gaugeline will not guess where a content type's pages are. If it has no pages of its own, this is expected.",
      "url": "https://ash-and-ember.example"
    }
  ],
  "passed": []
}
```

The brewers' dinner is published in Contentful and `/events/brewers-dinner` answers 404, so the announcement the owner sent leads to an error page: the host never rebuilt. The testimonials are the one "could not check": they have published entries and no pattern, so Gaugeline does not know where their pages are. The freelancer knows they are on the home page, so this line is expected. A finding names the content type, the entry's slug and the status; nothing of the owner's titles.

## The check, and the preview-token check

| Check                      | Severity | Finds                                                                                                   |
| -------------------------- | -------- | ------------------------------------------------------------------------------------------------------- |
| `contentful-entry-no-page` | high     | A published entry whose address, from the pattern in the settings, answers 404 or 410 on the live site. |

It is in the [checks reference](/docs/checks) with what it catches, why it matters, how to fix it and a technical line. An entry in a content type with a pattern that has no slug, or a slug the pattern cannot turn into an address, is could-not-check by name, not skipped. The check does not run from a command yet: like the other content checks it uses the adapter as it arrives (`readContentful` and `createContentfulRegistry` in Gaugeline's core).

**A preview token in your site's JavaScript.** This one is not part of the adapter and needs no Contentful key: it is the existing [`secret-in-js`](/docs/checks) check, taught Contentful's shape. A Content Preview API token reads every entry saved in the space, drafts included, so it must stay on the server. The check reads the page's inline scripts and up to 15 same-site script files (as for every key) and reports a 43-character token that is named like a token or key and tied to `preview.contentful.com`: in the same object as the host, in the same address as `?access_token=`, or in a name that says "preview" in a file that names Contentful. A Delivery token is public by design and is not reported by this detector, and neither is the preview host that the Contentful SDK itself contains. The finding says the kind of key and where it is (the file and the byte), and shows only the first 6 and the last 2 characters of the token; the rest is never stored. Found one? Revoke the token in **Settings, API keys** now, make a new one, and fetch preview content from a server route.

## What cannot be checked

Anything the platform does not expose is could-not-check, with the reason, never a pass and never scraped from Contentful's web app:

| Question                                            | Answer here                         | Why                                                                                                            |
| --------------------------------------------------- | ----------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| Who has access to the space (`members`)             | not offered                         | The Delivery API has no members list. Reading it takes a Management token, which Gaugeline does not use.       |
| Entries saved and changed since they were published | not offered                         | The Delivery API serves only the published version. Seeing the draft side takes the Preview or Management API. |
| When an entry was first published                   | not offered                         | The Delivery API gives `sys.updatedAt`, not a publish date.                                                    |
| Whether a page shows the same words as the CMS      | not decided here                    | The adapter gives hashes; the comparison with the page is the published-but-not-live check (F-05).             |
| A content type's page address                       | only from your `urls` settings      | Contentful has no pages of its own; the route is in your Next.js code, so Gaugeline does not guess.            |
| Entries in other locales                            | not read                            | Only the default locale is.                                                                                    |
| A token not enabled for the environment             | could not check, naming the setting | Never an empty result.                                                                                         |

## When it cannot check

It never returns a list with a hole in it. The read is could-not-check, with the reason in plain words, when:

- `CONTENTFUL_SPACE_ID` or `CONTENTFUL_DELIVERY_TOKEN` is not set (nothing is asked), or either is not the shape Contentful uses, or Contentful does not accept the token (HTTP 401);
- the space, the environment or the token's access to it is not found (HTTP 404);
- an answer is not the shape Contentful sends, or an entry has no id or no update time;
- a content type is bigger than the bound, a page of entries is too big even at 10, or the list stops before its total; a content type has published entries and no `urls` pattern, or an entry has no slug for the pattern (its pages were not checked); or a live page answers anything but a page or a 404 or 410, in which case that one page is could-not-check.

A space that asks Gaugeline to slow down (HTTP 429) is waited for once when it says how long and the wait is a minute or less; after that the run keeps what it had read and says it is partial, and the check does not pass.

## What is bounded

| Limit                              | Value  |
| ---------------------------------- | ------ |
| Entries in one page of a list      | 100    |
| Entries read from one content type | 10,000 |
| Live pages asked for in one run    | 300    |

There are no flags to raise them. A page beyond the budget is could-not-check, named in the result, not skipped quietly. An address pattern that points at another site is not asked.

## Settings

| `gaugeline.adapters.json` field | What it does                                                                                                                                                                                                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `adapters[].id`                 | `contentful`.                                                                                                                                                                                                      |
| `adapters[].fingerprint`        | Fields to hash, by content type id, by Contentful's own field ids (`title`, `summary`). Up to 20 per content type.                                                                                                 |
| `adapters[].urls`               | Where a content type's pages live: a path or an https address on the site. Only `{slug}` and `{id}` are filled in. A type with no entry has its pages left out of the page check and is listed as could not check. |

| Environment variable        | What it is                                                                        |
| --------------------------- | --------------------------------------------------------------------------------- |
| `CONTENTFUL_SPACE_ID`       | The space's id. Required.                                                         |
| `CONTENTFUL_DELIVERY_TOKEN` | The Content Delivery API access token. Required.                                  |
| `CONTENTFUL_ENVIRONMENT`    | The environment id. Optional; `master` when not set.                              |
| `CONTENTFUL_PREVIEW_TOKEN`  | The Content Preview API access token. Optional; only used to say if drafts exist. |

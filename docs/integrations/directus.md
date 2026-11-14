# Directus: content checks for sites built on Directus

What a Directus site's CMS says is published, against what the live site shows. Gaugeline only reads: it sends `GET` requests to Directus's REST API with a static token, and nothing else.

## What this adapter reads, and the narrowest key

**The key first.** Directus has no key type that is read-only by itself. A static token belongs to a Directus user, and what it may do is what that user's role allows. So the narrowest key is a **static token on a user whose role can only read the collections you will name to Gaugeline**: read on those collections (and on their `status`, `date_created` and `date_updated` fields), and no create, update or delete on anything. Gaugeline's key kind for Directus is `read-only`, and the narrowing is yours to make in the role: Gaugeline sends only `GET`, but it cannot make a token weaker than the role behind it. Use a user made for this and nothing else, never an administrator's token.

This page lists what the adapter reads, a worked example for a freelancer's client, what it could not check and why, and what Gaugeline will not do. See [Content systems](/docs/integrations/) for the interface every adapter shares.

**A note on sources.** Documentation checked on: 2026-11-11. Directus's own documentation could not be reached when this page was written (the build session's network policy refused `docs.directus.io`). What is confirmed is from the source of Directus's own JavaScript package, [@directus/sdk 27.1.0 on npm](https://www.npmjs.com/package/@directus/sdk) [docs]: the items route is `GET /items/{collection}`, a static token is sent as `Authorization: Bearer <token>`, and the query parameters are `fields` (comma-separated), `filter` (JSON), `sort`, `limit`, `offset` and `page`. Everything else on this page is from the build's knowledge of Directus and is **uncited**: that `meta=filter_count` adds the count after the filter to the answer, that the answer is `{ "data": [...] }`, the field names `status`, `date_created` and `date_updated`, the `_or`, `_neq` and `_null` filter operators, that a collection the role may not read (or that does not exist) answers 403, the error envelope `errors[].extensions.code` with the codes `FORBIDDEN` and `INVALID_CREDENTIALS`, and the user and role settings below. Each is pinned by Gaugeline's tests over invented answers, not confirmed against the live pages. Check them against the current Directus docs before relying on a detail: [REST API: items](https://docs.directus.io/reference/items.html) [docs], [query parameters](https://docs.directus.io/reference/query.html) [docs], [access control](https://docs.directus.io/guides/auth/access-control.html) [docs].

## What it reads

Every request is a `GET` to your `DIRECTUS_URL`, through the same fetcher as every other request.

| Endpoint                                 | Key             | What for                                                                                                                                                                                                                         |
| ---------------------------------------- | --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /items/{collection}`                | read-only token | The items of a collection you named: counts, fingerprints and field counts. Pages of up to 100 (`limit`, `offset`, `sort=id`), asking only for the fields needed (`fields`: the id, status, slug, dates and the fields to hash). |
| `GET /items/{collection}`, with a filter | read-only token | A count of the items whose status is not `published` (`filter`, `limit=1`, `fields=id`, `meta=filter_count`), for whether unpublished work is reachable.                                                                         |
| `GET /items/{collection}`, no token      | none            | Only with `--owner-consent`, and only for collections you list in `privateCollections`: whether a visitor can list them (`limit=1`, `fields=id`). See [the two checks](#the-two-checks).                                         |

**Gaugeline does not ask Directus to list its collections.** You name the collections to read, by their name in Directus (letters, digits and underscores, such as `classes`), as keys of `urls` or `fingerprint` in `gaugeline.adapters.json`. A collection you do not name is not read.

**What "published" means.** Directus has no built-in published state; the usual convention is a `status` field with the values `published`, `draft` and `archived`. Gaugeline reads an item as published when its `status` is exactly `published`; any other value, and an empty status, is not published. A status that is present but is not text (a number, `false`, an object) is not published. A collection whose answer has no `status` field at all (the key is missing) has no drafts to hold back, so all its items count as live. A collection that uses other words for its states (`live`, say) shows no published items here, and the check says nothing about it: rename the values or name another collection. Directus answers a filter on a field the collection does not have with an error; Gaugeline treats that as "no status field" only after reading one whole item that shows it has none, and otherwise the question is could-not-check.

A collection that has no `status`, `date_updated`/`date_created`, or (when its `urls` pattern uses `{slug}`) `slug` field is could-not-check as a whole, with Directus's reason; the others are still read. Gaugeline asks for `slug` only when the collection's pattern uses it.

Single-item collections (a settings or home page, "singletons") answer one object and are counted as one. Relations and files are read as Directus sends them (an id, not the related item). Ids (numbers or UUIDs), slugs and times only are kept: a name, a price or a paragraph is read to be counted or hashed and is never kept, printed or put in a finding. Pages are stepped by the number of items that came back, so a server that holds answers below the `limit` asked for is followed; the end of a list is the reported count (`meta.filter_count`) when there is one, and an empty page when there is none.

Rate limits: when Directus answers 429 with a short `Retry-After`, Gaugeline waits once and goes on; after that it keeps what it read and says the result is partial.

## Make the key

In Directus's admin, make a role (or an access policy) and a user for Gaugeline. Give the role **read** on the collections you will name, with the fields above, and no other permission. Then open the user, find **Token** and generate a static token. The exact menu names differ between Directus versions (uncited): check the access-control page above.

Put the token in the environment where Gaugeline runs, never in a file you commit:

```text
DIRECTUS_URL=https://cms.client.example
DIRECTUS_TOKEN=<the static token of the read-only user>
```

The token goes in an `Authorization` header and never in an address, it is sent only to the Directus address you configured and only over `https`, it is dropped if the server redirects to another origin, and every message, finding and report has it blanked.

### What reaches your computer

Directus sends each item's field data with it unless `fields` leaves it out, and Gaugeline sends `fields` so that only the id, status, slug, dates and the fields named under `fingerprint` come back (if Directus answers 400 to that list, Gaugeline asks again for whole items). Field values are used for exactly two things: counting which items have a field and hashing the fields the settings name. The adapter keeps no value, and nothing but the short hash is printed, logged or put in a finding or report. With no `fingerprint` in the settings, nothing is hashed at all. The visitor request of the privacy check asks for `fields=id` and one item.

## Example: a yoga studio on Directus

Larkspur Yoga Studio is an invented small studio. A freelancer built its site with Next.js on a Directus backend: classes (one page each), teachers (one page each), a few notices, and a private `appointments` collection of bookings that only the front desk should see. The owner edits Directus between classes and publishes from her phone. The freelancer wants to know, before the owner does, which published classes have no page, and whether the Public role was left open on the bookings.

Settings go in `gaugeline.adapters.json` in the project folder. Nothing in it is a key. Only the collections you give an address pattern (`urls`) have their pages checked, and only the collections in `privateCollections` are asked about as a visitor.

```json title=gaugeline.adapters.json
{
  "adapters": [
    {
      "id": "directus",
      "fingerprint": { "classes": ["name", "summary"] },
      "urls": { "classes": "/classes/{slug}", "teachers": "/teachers/{slug}" },
      "privateCollections": ["appointments"]
    }
  ]
}
```

With `DIRECTUS_URL` and `DIRECTUS_TOKEN` in the environment, this is what the adapter reads over the studio's Directus (invented: one class saved as a draft):

```json title=Output
{
  "types": [
    {
      "name": "classes",
      "count": 2
    },
    {
      "name": "teachers",
      "count": 2
    }
  ],
  "class fields": {
    "name": 2,
    "summary": 1,
    "slug": 2,
    "seats": 0
  },
  "drafts reachable": true,
  "published classes": [
    {
      "id": "1",
      "type": "classes",
      "url": "/classes/morning-flow",
      "slug": "morning-flow",
      "updatedAt": "2026-10-20T08:30:00.000Z",
      "fieldHashes": {
        "name": "bf6cfe02935d0830",
        "summary": "0eb2f492ce8a2e14"
      }
    },
    {
      "id": "2",
      "type": "classes",
      "url": "/classes/evening-stretch",
      "slug": "evening-stretch",
      "updatedAt": "2026-11-02T17:00:00.000Z",
      "fieldHashes": {
        "name": "b2034730d8a459ff"
      }
    }
  ]
}
```

Read it the way the freelancer does. Classes has two published items, though Directus holds three: the third has the status `draft`. `drafts reachable` is `true` because the token can read an item that is not published. The evening stretch has no `summary`, so it has no hash for it (a field an item lacks is left out, never hashed as empty), and `seats` counts 0 because no item has one. The hashes stand for the studio's class names and summaries, which are not in the output.

The two checks then run over that site and its live pages, with the owner's consent for the second (invented: the Public role was left open on `appointments`):

```json title=Findings
{
  "findings": [
    {
      "check": "directus-entry-no-page",
      "severity": "high",
      "evidence": "classes: evening-stretch is published in Directus and /classes/evening-stretch answers 404",
      "url": "https://larkspur-yoga.example/classes/evening-stretch"
    },
    {
      "check": "directus-collection-public",
      "severity": "high",
      "evidence": "appointments: a request with no token listed 2 items, and gaugeline.adapters.json marks the collection private",
      "url": "https://larkspur-yoga.example"
    }
  ],
  "could not check": [],
  "passed": []
}
```

- **`directus-entry-no-page`**: the evening stretch is published in Directus and the Next.js site has no page for it (a route that was not built, or a slug changed). A client who follows the link the studio posted gets an error page.
- **`directus-collection-public`**: a visitor with no token can list the bookings. The finding is a collection name and a count; no booking is shown. The fix is in Directus, under **Settings, Access Policies, Public**: remove read access from `appointments` and read it on the server with the token of a limited user.

## The two checks

Both are in the [checks reference](/docs/checks) with what they catch, why it matters, how to fix it and a technical line.

| Check                        | Severity | Finds                                                                                                  |
| ---------------------------- | -------- | ------------------------------------------------------------------------------------------------------ |
| `directus-entry-no-page`     | high     | A published item whose address, from the pattern in the settings, answers 404 or 410 on the live site. |
| `directus-collection-public` | high     | A collection you marked private whose items a visitor who sends no token can list (probing).           |

**`directus-collection-public` is a probing check.** It asks Directus for collections the owner says are private, as a visitor, so it is off unless you pass `--owner-consent` (or put the consent in `gaugeline.consent.json`), and it should be run only on sites you own or have permission to test. Without consent Gaugeline asks nothing as a visitor and the check says it was not asked; it is never a pass. It asks only for the collections you list in `privateCollections` (the Public role is often open on purpose, so a collection you did not mark is never asked), with no token and none of the headers Gaugeline may add for a protected preview, and reads one item's id and the count, nothing else. A 401 or 403 counts as a closed collection only when its body is Directus's own error envelope (error code `FORBIDDEN` or `INVALID_CREDENTIALS`): a 403 from a firewall or CDN (an "Attention Required" page, say) is could-not-check, never a pass. Directus also answers 403 for a collection that does not exist (uncited), so a closed collection passes only when the token can read the same collection (a second request, with the token, for one item's id); otherwise it is could-not-check, named, with "spelling unconfirmed". A Public policy that allows some fields of the collection but not `id` also answers 403 to the `id` request, so a pass means no public read of `id` was seen, not that nothing is public. A visitor request that is answered with a redirect is not followed and is could-not-check, and when the token is what failed to confirm the spelling, the note names `DIRECTUS_TOKEN`. A 200 with an item is the finding. A 200 with no items is could-not-check (the role may read it, and there was nothing to count). Anything else is could-not-check with the reason. It sends no login, no form and no guess at an id.

The checks do not run from a command yet: like the other content checks they use the adapter as it arrives (`readDirectus` and `createDirectusRegistry` in Gaugeline's core).

## What cannot be checked

Anything the platform does not expose is could-not-check, with the reason, never a pass and never scraped from Directus's admin:

| Question                                          | Answer here                           | Why                                                                                                |
| ------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Which collections the site has                    | only the ones you name                | Gaugeline does not ask Directus for its collections.                                               |
| Whether the Public role can read a collection     | only for collections you mark private | A collection you did not mark is never asked as a visitor.                                         |
| Whether a collection uses a different state field | not offered                           | Only a `status` field with the value `published` is read as live.                                  |
| Who has access to the admin (`members`)           | not offered                           | A static token is not asked for users or roles.                                                    |
| Whether a page shows the same words as the CMS    | not decided here                      | The adapter gives hashes; the comparison with the page is the published-but-not-live check (F-05). |
| A collection's page address                       | only from your `urls` settings        | The API does not say where the front end serves a collection, so Gaugeline does not guess.         |
| Content versions and drafts held in a version     | not read                              | Only the items as the token lists them.                                                            |
| Translations                                      | not read                              | Only the fields on the item itself.                                                                |
| A collection the token may not read               | could not check, for that collection  | The others are still read. Directus answers 403 for this and for a collection that does not exist. |
| GraphQL                                           | not used                              | The REST routes cover everything above.                                                            |

## When it cannot check

It never returns a list with a hole in it. The read is could-not-check, with the reason in plain words, when:

- `DIRECTUS_URL` is not set, is not an address, has a user name or password in it, or is `http` while a token is set (the token is not sent over plain http);
- `DIRECTUS_TOKEN` is not set and the question is about unpublished work, or Directus does not accept it (HTTP 401), or the role may not read the collection or one of its fields (HTTP 403, which Directus also answers for a collection that does not exist: check the spelling);
- a name under `urls`, `fingerprint` or `privateCollections` is not a Directus collection name, or no collection is named at all (the page check says so and does not pass);
- an answer is not the shape Directus sends, an item has no id or neither `date_updated` nor `date_created`, a collection is bigger than the bound, a page is too big even at 10 items, or the list stops before its count;
- Directus refuses the status filter and no item shows the collection has no status field;
- no item of a collection reads as published (every status is something else, such as `live`, or the collection is empty): its pages were not checked, and the page check does not pass;
- the same item is listed twice, or the count Directus reports changes or does not match what came back, while one collection is read (the list moved under the read, or the server ignores `offset`);
- the page check asked no page at all;
- `DIRECTUS_TOKEN` has a space, a line break or a character that is not plain ASCII in it;
- a 401 or 403 to the visitor request that is not Directus's own error answer;
- a collection has published items and no `urls` pattern, or an item has no slug for the pattern (its pages were not checked), or a live page answers anything but a page or a 404 or 410 (a 503, a login, a timeout), in which case that one page is could-not-check.

## What is bounded

| Limit                           | Value  |
| ------------------------------- | ------ |
| Items in one page of a list     | 100    |
| Items read from one collection  | 10,000 |
| Live pages asked for in one run | 300    |

There are no flags to raise them. A page beyond the budget is could-not-check, named in the result, not skipped quietly. An address pattern that points at another site is not asked.

## Settings

| `gaugeline.adapters.json` field | What it does                                                                                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapters[].id`                 | `directus`.                                                                                                                                                      |
| `adapters[].fingerprint`        | Fields to hash, by collection name. Up to 20 per collection. Naming a collection here also means it is read.                                                     |
| `adapters[].urls`               | Where a collection's pages live: a path or an https address on the site. Only `{slug}` and `{id}` are filled in. Naming a collection here also means it is read. |
| `adapters[].privateCollections` | Collections a visitor with no token must not be able to read. Switches on the privacy check (with `--owner-consent`). Up to 50 names.                            |

| Environment variable | What it is                                                                  |
| -------------------- | --------------------------------------------------------------------------- |
| `DIRECTUS_URL`       | The Directus address, such as `https://cms.client.example`. Required.       |
| `DIRECTUS_TOKEN`     | A static token of a read-only user. Needed for unpublished work; see above. |

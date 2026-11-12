# Payload: content checks for sites built on Payload

What a Payload site's CMS says is published, against what a visitor can read. Gaugeline only reads: it sends `GET` requests to Payload's REST API with an API key, and nothing else.

## What this adapter reads, and the narrowest key

**The key first.** Payload has no key type that is read-only by itself. An API key belongs to a **user** of a collection that has `auth.useAPIKey` turned on, and what the key may do is what the collection access rules allow that user. So the narrowest key is **an API key on a user whose access is read-only**: a user that the `read` rule of each collection you will name lets in, and that no `create`, `update` or `delete` rule lets in. Gaugeline's key kind for Payload is `read-only`, and the narrowing is yours to make in the access rules: Gaugeline sends only `GET`, but it cannot make a key weaker than the user behind it. Use a user made for this and nothing else, never an administrator's key.

This page lists what the adapter reads, a worked example for a freelancer's client, what it could not check and why, and what Gaugeline will not do. See [Content systems](/docs/integrations/) for the interface every adapter shares. There is also a [recipe for Payload](/docs/integrations/recipes/) on the generic API adapter; it stays as the fallback, and this adapter reads the same recorded answers as that recipe and gives the same counts and fingerprints.

**A note on sources.** Documentation checked on: 2026-11-12. Payload's website (`payloadcms.com`) could not be reached when this page was written (the build session's network policy refused it). What is confirmed is from the documentation sources in Payload's own repository, read as raw files, and from the source of the [payload 3.93.0 package on npm](https://www.npmjs.com/package/payload) [docs]:

- the REST API is mounted under `routes.api` (default `/api`), a collection is at `/api/{collection-slug}`, and collection slugs are kebab-case: [REST API](https://payloadcms.com/docs/rest-api/overview) [docs];
- the list route is paginated and answers `docs`, `totalDocs`, `limit`, `totalPages`, `page`, `pagingCounter`, `hasPrevPage`, `hasNextPage`, `prevPage` and `nextPage`, with the `limit` and `page` parameters: [Pagination](https://payloadcms.com/docs/queries/pagination) [docs];
- a key is sent as `Authorization: <auth collection slug> API-Key <key>`, the header is case-sensitive, and the key acts as its user under the same access control as any login: [API keys](https://payloadcms.com/docs/authentication/api-keys) [docs];
- `where` queries are written `where[field][operator]=value` with the `equals` operator, `select[field]=true` limits the fields and `id` always comes back, `sort` takes a top-level field name, and `depth` populates relationships: [Queries](https://payloadcms.com/docs/queries/overview) [docs], [Select](https://payloadcms.com/docs/queries/select) [docs], [Sort](https://payloadcms.com/docs/queries/sort) [docs];
- a collection with drafts turned on has a `_status` field holding `draft` or `published`, an ordinary read returns the documents of the main collection (drafts included) unless the collection's `read` access narrows them, and a document saved before drafts were turned on has no `_status` until it is saved again: [Drafts](https://payloadcms.com/docs/versions/drafts) [docs];
- a collection with no `read` rule answers a request with no signed-in user with 403 `{ "errors": [{ "message": "You are not allowed to perform this action." }] }`, a rule that returns false does the same, a key that matches no user is a request with no user (so it is 403, not 401), and a slug Payload does not have is a 404 that is answered before access is looked at: from the `payload` package's own code (`executeAccess`, `Forbidden`, `getRequestCollection`, the API key strategy) and the English text in its translations package [docs].

Everything else on this page is from the build's knowledge of Payload and is **uncited**: that `sort=id` is accepted on every collection, that `select[id]=true` is accepted, that a `select` that names a field the collection does not have is ignored or refused with 400 (Gaugeline asks again for whole documents once if it is refused), that a `where` on `_status` for a collection with no drafts is refused with 400, that a site in another language answers the refusal in that language (Gaugeline then says it could not tell), and the access-rule example below. Each is pinned by Gaugeline's tests over invented answers, not confirmed against a live site. Check them against the current Payload docs before relying on a detail: [access control](https://payloadcms.com/docs/access-control/overview) [docs], [collections](https://payloadcms.com/docs/configuration/collections) [docs].

## What it reads

Every request is a `GET` to your `PAYLOAD_URL`, through the same fetcher as every other request.

| Endpoint                                        | Key           | What for                                                                                                                                                                                                                                  |
| ----------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET {PAYLOAD_URL}/{collection}`                | read-only key | The documents of a collection you named: counts, fingerprints and field counts. Pages of up to 100 (`limit`, `page`, `sort=id`, `depth=0`), asking only for the fields needed (`select`: the status, slug, dates and the fields to hash). |
| `GET {PAYLOAD_URL}/{collection}`, with a filter | read-only key | A count of the documents whose `_status` is `draft` (`where[_status][equals]=draft`, `limit=1`, `select[_status]=true`), for whether unpublished work is reachable. Only the reported `totalDocs` is read.                                |
| `GET {PAYLOAD_URL}/{collection}`, no key        | none          | Only with `--owner-consent`, and only for collections you list in `privateCollections`: whether a visitor can list them (`limit=1`, `select[id]=true`). See [the check](#the-check).                                                      |

**`PAYLOAD_URL` is Payload's API address, with its route.** In most sites that is `https://cms.client.example/api`: Payload lets a site change `routes.api`, so Gaugeline does not guess the prefix. A 404 on a collection you named says so.

**Gaugeline does not ask Payload to list its collections.** You name the collections to read, by their slug (lower-case letters, digits and hyphens, such as `posts`), as keys of `urls` or `fingerprint` in `gaugeline.adapters.json`. A collection you do not name is not read. Globals and single-document collections are not read.

**What "published" means.** A collection with drafts turned on has a `_status` field. Gaugeline reads a document as published when its `_status` is exactly `published`; any other value, and a `_status` that is not text, is not published. A collection whose answer has no `_status` at all (the key is missing) has no drafts to hold back, so all its documents count as live. That is also what a document saved before drafts were turned on looks like, so it is live here; save it again in Payload to give it a status. Every document of a collection is read to count the live ones, so a count and the published list always agree. When Payload refuses the `_status` query with 400, Gaugeline treats that as "no drafts" only after reading one whole document that shows it has no `_status`, and otherwise the question is could-not-check.

A document keeps its id (a number or a text such as an ObjectId or a UUID), its slug when the collection's `urls` pattern uses `{slug}`, its `updatedAt` and its `createdAt`. **`publishedAt` is the document's `createdAt`**: Payload has no publish date of its own, and the recipe for Payload uses `createdAt` too, so the two agree. The change time that matters is `updatedAt`; a document with neither is could-not-check. Relationships and uploads are read as ids (`depth=0`). A name, a price or a paragraph is read to be counted or hashed and is never kept, printed or put in a finding.

**The order and the end of a list are checked, not assumed.** Documents are read in a fixed order (`sort=id`), one page at a time, and `page` is exactly the number of documents already read divided by the page size, plus one. The list ends when exactly `totalDocs` documents have been read, with every id seen once. A `totalDocs` that moves between pages, an answer for another page than the one asked for, a page that holds fewer documents than asked while Payload says there are more, a repeated id, an empty page before the end, a `hasNextPage` that disagrees with the count or a list longer than the bound is could-not-check, never the end of the list.

Rate limits: when Payload answers 429 with a short `Retry-After`, Gaugeline waits once and goes on; after that it keeps what it read and says the result is partial.

## Make the key

In Payload, give one of your auth collections `auth: { useAPIKey: true }` (the starter template's `users` collection is the usual one). Make a user for Gaugeline in the admin panel, open it, turn on **Enable API Key** and copy the key: Payload shows it once. Then make that user read-only in your access rules. Payload has no built-in roles, so how is yours to choose; the plainest is a `role` field on the user (such as `reader` and `editor`) and, on each collection you will name, a `read` rule that lets both in and `create`, `update` and `delete` rules that let only `editor` in (uncited, an example, not a requirement). The exact menu names and options differ between Payload versions: check the API keys page above.

Put the key in the environment where Gaugeline runs, never in a file you commit:

```text
PAYLOAD_URL=https://cms.client.example/api
PAYLOAD_API_KEY=<the API key of the read-only user>
```

If the user is not in a collection called `users`, say which in `gaugeline.adapters.json` with `authCollection` (the header carries the collection's slug).

The key goes in an `Authorization` header and never in an address, it is sent only to the address you configured and only over `https`, it is dropped if the server redirects to another origin, and every message, finding and report has it blanked. Payload answers 403 for a key it does not recognise (a wrong key, a key of a user in another collection, a key made before the server's `PAYLOAD_SECRET` changed) the same way it answers for a user who may not read the collection, so a 403 on a collection you named is could-not-check with all those possibilities named.

### What reaches your computer

Payload sends each document's field data with it unless `select` leaves it out, and Gaugeline sends `select` so that only the status, slug, dates and the fields named under `fingerprint` come back (if Payload answers 400 to that list, Gaugeline asks again for whole documents). Field values are used for exactly two things: counting which documents have a field and hashing the fields the settings name. The adapter keeps no value, and nothing but the short hash is printed, logged or put in a finding or report. With no `fingerprint` in the settings, nothing is hashed at all. The visitor request of the privacy check asks for one document's id.

## Example: a coffee roaster on Payload

Quillon Coffee Roasters is an invented small roastery. A freelancer built its site with Next.js and put Payload in the same app: journal posts (one page each), events (one page each), and a `wholesale-orders` collection of orders from cafes that only the owner should see. The owner writes posts between roasts and saves some as drafts. The freelancer wants to know, before the owner does, whether the orders collection was left readable by visitors, the way it was while the site was being built.

Settings go in `gaugeline.adapters.json` in the project folder. Nothing in it is a key. Only the collections in `privateCollections` are asked about as a visitor.

```json title=gaugeline.adapters.json
{
  "adapters": [
    {
      "id": "payload",
      "fingerprint": { "posts": ["title", "summary"] },
      "urls": { "posts": "/journal/{slug}", "events": "/events/{slug}" },
      "privateCollections": ["wholesale-orders"]
    }
  ]
}
```

With `PAYLOAD_URL` and `PAYLOAD_API_KEY` in the environment, this is what the adapter reads over the roastery's Payload (invented: one post saved as a draft):

```json title=Output
{
  "types": [
    {
      "name": "events",
      "count": 2
    },
    {
      "name": "posts",
      "count": 2
    }
  ],
  "post fields": {
    "title": 2,
    "summary": 1,
    "slug": 2,
    "subtitle": 0
  },
  "drafts reachable": true,
  "published posts": [
    {
      "id": "6650a1c0",
      "type": "posts",
      "url": "/journal/harvest-blend",
      "slug": "harvest-blend",
      "publishedAt": "2026-10-01T09:00:00.000Z",
      "updatedAt": "2026-10-20T08:30:00.000Z",
      "fieldHashes": {
        "title": "13c561b963542e6e",
        "summary": "c2a052cd38137063"
      }
    },
    {
      "id": "6650a1c1",
      "type": "posts",
      "url": "/journal/our-decaf",
      "slug": "our-decaf",
      "publishedAt": "2026-10-05T09:00:00.000Z",
      "updatedAt": "2026-11-02T17:00:00.000Z",
      "fieldHashes": {
        "title": "cb839c0cae727a93"
      }
    }
  ]
}
```

Read it the way the freelancer does. The journal has two published posts, though Payload holds three: the third has the `_status` `draft`. `drafts reachable` is `true` because the key can read a document that is a draft (events have no drafts, so they say nothing). The decaf post has no `summary`, so it has no hash for it (a field a document lacks is left out, never hashed as empty), and `subtitle` counts 0 because no post has one. `publishedAt` is when the post was first saved. The hashes stand for the roastery's post titles and summaries, which are not in the output.

The check then runs over that site, with the owner's consent (invented: `wholesale-orders` has a `read` rule that returns true):

```json title=Findings
{
  "findings": [
    {
      "check": "payload-collection-public",
      "severity": "high",
      "evidence": "wholesale-orders: a request with no key listed 2 documents, and gaugeline.adapters.json marks the collection private",
      "url": "https://studio.quillon-coffee.example"
    }
  ],
  "could not check": [],
  "passed": []
}
```

- **`payload-collection-public`**: a visitor with no key can list the orders. The finding is a collection slug and a count; no order is shown. The fix is in the collection's config: replace the `read` rule that returns true with one that needs a signed-in user, and read the data on the server where the front end needs it.

## The check

It is in the [checks reference](/docs/checks) with what it catches, why it matters, how to fix it and a technical line.

| Check                       | Severity | Finds                                                                                          |
| --------------------------- | -------- | ---------------------------------------------------------------------------------------------- |
| `payload-collection-public` | high     | A collection you marked private whose documents a visitor who sends no key can list (probing). |

**`payload-collection-public` is a probing check.** It asks Payload for collections the owner says are private, as a visitor, so it is off unless you pass `--owner-consent` (or put the consent in `gaugeline.consent.json`), and it should be run only on sites you own or have permission to test. Without consent Gaugeline asks nothing as a visitor and the check says it was not asked; it is never a pass. It asks only for the collections you list in `privateCollections` (a Payload collection is often public on purpose, so a collection you did not mark is never asked), with no key and none of the headers Gaugeline may add for a protected preview, redirects not followed, and reads one document's id and the count, nothing else. A 403 counts as a closed collection only when its body is Payload's own refusal (`errors[0].message` is `You are not allowed to perform this action.`): a 403 from a firewall or CDN (an "Attention Required" page, say), or a refusal in another language, is could-not-check, never a pass. Payload looks a collection up before it looks at access, so a collection that does not exist is a 404 and is named as could-not-check with the spelling to check, never read as closed. A 200 with a document is the finding. A 200 with no documents is could-not-check (a visitor may read it, and there was nothing to count). Anything else is could-not-check with the reason. A pass means no public read of the list was seen: a collection can still allow single documents by id, a `where` that narrows what a visitor sees, or its GraphQL route, which this check does not ask. It sends no login, no form and no guess at an id.

The checks do not run from a command yet: like the other content checks they use the adapter as it arrives (`readPayload` and `createPayloadRegistry` in Gaugeline's core).

## What cannot be checked

Anything the platform does not expose is could-not-check, with the reason, never a pass and never scraped from Payload's admin panel:

| Question                                          | Answer here                             | Why                                                                                                                                      |
| ------------------------------------------------- | --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| Which collections the site has                    | only the ones you name                  | Gaugeline does not ask Payload for its collections.                                                                                      |
| Whether a visitor can read a collection           | only for collections you mark private   | A collection you did not mark is never asked as a visitor.                                                                               |
| Whether a collection uses a different state field | not offered                             | Only a `_status` field with the value `published` is read as live.                                                                       |
| Who has access to the admin (`members`)           | not offered                             | An API key is not asked for users.                                                                                                       |
| Whether a page shows the same words as the CMS    | not decided here                        | The adapter gives hashes; the comparison with the page is the published-but-not-live check (F-05).                                       |
| A collection's page address                       | only from your `urls` settings          | The API does not say where the front end serves a collection, so Gaugeline does not guess.                                               |
| Versions, and drafts held in a version            | not read                                | Only the documents as the key lists them; the `draft` read parameter is never sent.                                                      |
| What `drafts reachable: false` means              | no listed document has `_status: draft` | Drafts of already-published documents live in versions and are not seen (uncited, from how Payload's update path works).                 |
| A `_status` the key may not read                  | reads as a collection with no drafts    | A field-level read rule that hides `_status` makes the collection look like it has none, so `drafts reachable` can be `false` (uncited). |
| Localised fields                                  | not read                                | Only the fields on the document in the default locale.                                                                                   |
| Globals                                           | not read                                | Only collections are named.                                                                                                              |
| A collection the key's user may not read          | could not check, for that collection    | The others are still read. Payload answers 403 for this and for a key it does not recognise.                                             |
| GraphQL                                           | not used                                | The REST routes cover everything above.                                                                                                  |

## When it cannot check

It never returns a list with a hole in it. The read is could-not-check, with the reason in plain words, when:

- `PAYLOAD_URL` is not set, is not an address, has a user name or password in it, or is `http` while a key is set (the key is not sent over plain http);
- `PAYLOAD_API_KEY` is not set and the question is about unpublished work, or Payload does not accept it (HTTP 403, which Payload also answers for a user who may not read the collection: check the key, `authCollection` and the user's access), or it has a space, a line break or a character that is not plain ASCII in it;
- a name under `urls`, `fingerprint`, `privateCollections` or `authCollection` is not a Payload slug (lower-case letters, digits and hyphens), or no collection is named at all;
- a collection answers 404 (the slug is wrong, or `PAYLOAD_URL` does not include Payload's API route);
- an answer is not the shape Payload sends, a document has no id or neither `updatedAt` nor `createdAt`, a collection is bigger than the bound, a page is too big even at 5 documents, or the list stops before its count;
- Payload refuses the `_status` query and no document shows the collection has no `_status`;
- the same document is listed twice, an answer is for another page than the one asked for, or the count Payload reports changes or does not match what came back, while one collection is read (the list moved under the read, or the server ignores `page`);
- a refusal or a failure comes on any page after the first (the list is not read to the end, so it is not a pass);
- a 403 to the visitor request that is not Payload's own refusal, or a redirect, or a 404 (see [the check](#the-check)).

## What is bounded

| Limit                              | Value  |
| ---------------------------------- | ------ |
| Documents in one page of a list    | 100    |
| Documents read from one collection | 10,000 |

There are no flags to raise them. A collection over the bound is could-not-check, named in the result, never counted in part.

## Settings

| `gaugeline.adapters.json` field | What it does                                                                                                                                                     |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapters[].id`                 | `payload`.                                                                                                                                                       |
| `adapters[].fingerprint`        | Fields to hash, by collection slug. Up to 20 per collection. Naming a collection here also means it is read.                                                     |
| `adapters[].urls`               | Where a collection's pages live: a path or an https address on the site. Only `{slug}` and `{id}` are filled in. Naming a collection here also means it is read. |
| `adapters[].privateCollections` | Collections a visitor with no key must not be able to read. Switches on the privacy check (with `--owner-consent`). Up to 50 slugs.                              |
| `adapters[].authCollection`     | The slug of the auth collection that holds the key's user. Default `users`. Sent in the `Authorization` header, so only lower-case letters, digits and hyphens.  |

| Environment variable | What it is                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------ |
| `PAYLOAD_URL`        | Payload's API address, with its route, such as `https://cms.client.example/api`. Required. |
| `PAYLOAD_API_KEY`    | The API key of a read-only user. Needed for unpublished work; see above.                   |

# DatoCMS: content checks for sites built on DatoCMS

What a DatoCMS project says is published, against what the live site shows, and whether the token you gave Gaugeline can also read drafts. Gaugeline only reads, through DatoCMS's Content Delivery API, with an API token that has the narrowest access DatoCMS offers.

## What this adapter reads, and the narrowest key

**The key first.** DatoCMS's Content Delivery API is the read-only GraphQL API a site uses to fetch content, and it has no write endpoint. An API token is limited by two things: a role, and three flags that say which APIs it may call: `can_access_cda` (the Content Delivery API, published content), `can_access_cda_preview` (the same API with draft content) and `can_access_cma` (the Content Management API, which can write) [docs]. The narrowest token for Gaugeline is one with **`can_access_cda` on, `can_access_cda_preview` off and `can_access_cma` off**. Its role does not matter for reading: DatoCMS says a token with only `can_access_cda` is safe to attach to a role that can update, publish and delete, because the Content Delivery API has no endpoint those permissions could act on. Still, pick the role with the fewest permissions. Gaugeline's key kind for DatoCMS is `read-only`: with such a token a program can read published records, and it cannot change or delete anything.

This page lists what the adapter reads, a worked example for a freelancer's client, what the check finds, what could not be checked and why, and what Gaugeline will not do. See [Content systems](/docs/integrations/) for the interface every adapter shares.

**A note on sources.** Documentation checked on: 2026-11-11. DatoCMS's own documentation site (www.datocms.com/docs) could not be reached when this page was written, so no page of it was read. What is cited [docs] comes from DatoCMS's published npm packages, read on that date: `@datocms/cda-client` 0.3.2 (its README and source: the endpoint, the `POST` of `{ query }`, `Authorization: Bearer`, `X-Include-Drafts`, `X-Environment`, the limit of 500 records a page and `first` and `skip`) and `@datocms/cma-client` 6.8.0 (its API token reference: the three flags and the role). The GraphQL field names the adapter asks for (`id`, `_updatedAt`, `_publishedAt`) and the collection names such as `allClasses` are `uncited`: they are from the build's knowledge of DatoCMS's schema, so a wrong one shows up as a GraphQL error and could-not-check, never as a pass. The allowlist entry for the endpoint is recorded as not verified (`checked: null`) for the same reason. Check this page against DatoCMS's current documentation before relying on a detail.

## What it reads

Every request is a GraphQL **query**, sent as a `POST` to `https://graphql.datocms.com/`, because the Content Delivery API takes its queries that way (the endpoint has no `GET` form [docs]). It is the one exception to "Gaugeline only sends `GET` and `HEAD`" that [ADR-0006](https://github.com/alvinwquach/gaugeline/blob/main/docs/adr/0006-read-only-post-queries.md) allows: the request goes through `fetcher.query` only, to one registered allowlist entry (`datocms-cda-query`: the host `graphql.datocms.com`, the path `/`, and a body that must parse as one `query` document). A `mutation`, a `subscription`, a second operation, any other host and any other path is refused before anything is sent. Nothing else is ever sent.

| Query                                                                                    | What for                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query Page { allClasses(first: 100, skip: 0) { id _updatedAt _publishedAt slug ... } }` | The published records of a collection you named: counts, fingerprints and field counts. The collection is the one you name under `collections`; the fields are the ones you name under `fingerprint`. |
| the same with `{ id }` only                                                              | The size of a collection (`types()`), and the ids that the draft check subtracts.                                                                                                                     |
| the same `{ id }` query with the header `X-Include-Drafts: true`                         | Only when you set `expectPublishedOnly`: whether the token is given records that are not published. Ids only: no field of a draft is ever asked for.                                                  |

A page is at most 100 records and never more than 500, which is DatoCMS's own limit [docs]. The next page is asked for with `skip`, stepping by the number of records that came back, and a page shorter than the page asked for is the end of the list. A page that is too big for Gaugeline's size limit is asked again with half as many records, down to 10, and only then is the collection could-not-check. A record that shows up on two pages means the list moved while it was read, and the read is could-not-check rather than a count of a shifting list. When DatoCMS answers 429 with a short `Retry-After`, Gaugeline waits once and goes on; after that it keeps what it read and says the result is partial.

DatoCMS has no list of content types to ask, so you name them. Each entry under `collections` gives the GraphQL collection of a type (`allClasses` for the model with the API key `class`, as DatoCMS names it in your project's schema) and, if you want addresses, the field that holds the slug.

## Make the key

In the DatoCMS dashboard, open the project's Settings, then API tokens, and make a new token for Gaugeline: turn on access to the Content Delivery API, leave draft access (the preview flag) off and leave the Content Management API off. Give it a role with the fewest permissions. Put the token in the environment where Gaugeline runs, never in a file you commit:

```text
DATOCMS_TOKEN=<the API token>
DATOCMS_ENVIRONMENT=<optional: a sandbox environment such as staging>
```

The token goes in an `Authorization: Bearer` header and never in an address, it is sent only to `https://graphql.datocms.com/`, a redirect is never followed, and every message, finding and report has it blanked. `DATOCMS_ENVIRONMENT` is sent as the `X-Environment` header [docs] and only when it is a plain name (letters, digits, dots, hyphens and underscores); without it the primary environment is read.

### What reaches your computer

Gaugeline asks for exactly the fields it needs: `id`, `_updatedAt`, `_publishedAt`, the slug field you named, and the fields you list under `fingerprint`. Field values are used for exactly two things: counting which records have a field and hashing the fields the settings name. The adapter keeps no value, and nothing but the short hash is printed, logged or put in a finding or report. With no `fingerprint` in the settings, no field value is read at all. The draft check asks for ids only.

## Example: a yoga studio on DatoCMS

Larkspur Yoga Studio is an invented small studio. A freelancer built its site on DatoCMS and Next.js: classes (one page each), teachers (one page each) and a few notices. The owner edits the content between classes and publishes from her phone, and she is putting an autumn retreat together as a draft. The freelancer put a read-only token in the site's build settings and wants to know two things: that what DatoCMS says is published is what Gaugeline can see, and that the token in the build settings cannot show visitors the retreat before she announces it.

Settings go in `gaugeline.adapters.json` in the project folder. Nothing in it is a key.

```json title=gaugeline.adapters.json
{
  "adapters": [
    {
      "id": "datocms",
      "collections": {
        "classes": {
          "collection": "allClasses",
          "slug": "slug"
        },
        "notices": {
          "collection": "allNotices",
          "slug": "slug"
        },
        "teachers": {
          "collection": "allTeachers",
          "slug": "slug"
        }
      },
      "expectPublishedOnly": true,
      "fingerprint": {
        "classes": ["name", "summary"]
      },
      "urls": {
        "classes": "/classes/{slug}",
        "teachers": "/teachers/{slug}"
      }
    }
  ]
}
```

What the adapter reads over that project (a test compares this output with the tool, so it cannot drift):

```json title=Output
{
  "types": [
    {
      "name": "classes",
      "count": 2
    },
    {
      "name": "notices",
      "count": 1
    },
    {
      "name": "teachers",
      "count": 2
    }
  ],
  "class fields": {
    "name": 2,
    "summary": 1,
    "seats": 2
  },
  "a type that does not exist": "The type \"none\" is not named under \"collections\" in gaugeline.adapters.json, so it was not read.",
  "drafts reachable": true,
  "draft reading": [
    "classes: reachable, 2 published, 1 not published (ids 1003)",
    "notices: accepted-no-drafts, 1 published, 0 not published",
    "teachers: accepted-no-drafts, 2 published, 0 not published"
  ],
  "published classes": [
    {
      "id": "1001",
      "type": "classes",
      "url": "/classes/morning-flow",
      "slug": "morning-flow",
      "publishedAt": "2026-10-01T09:00:00.000Z",
      "updatedAt": "2026-10-20T08:30:00.000Z",
      "fieldHashes": {
        "name": "bf6cfe02935d0830",
        "summary": "0eb2f492ce8a2e14"
      }
    },
    {
      "id": "1002",
      "type": "classes",
      "url": "/classes/evening-stretch",
      "slug": "evening-stretch",
      "publishedAt": "2026-10-05T09:00:00.000Z",
      "updatedAt": "2026-11-02T17:00:00.000Z",
      "fieldHashes": {
        "name": "b2034730d8a459ff"
      }
    }
  ]
}
```

Read it the way the freelancer does. The published list has two classes, one notice and two teachers, and each class has an address the live site should answer. The second class has no summary, so its `summary` hash is missing rather than hashed as empty. The important line is `drafts reachable: true`: when the token asked for drafts, DatoCMS gave it a third class (id 1003) that the published list does not have. That is the autumn retreat, and the token in the build settings can read it. The freelancer turns off draft access on that token and makes a separate one for the preview site. The notices and teachers show `accepted-no-drafts`: the token was accepted for them too, but nothing there is unpublished, which proves nothing, so the check reports it as could-not-check.

The text of the client's pages never appears in a report: only counts, ids, slugs, dates and short hashes.

## The check

| Check                      | Needs                                         | What it finds                                                                                                                 |
| -------------------------- | --------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `datocms-drafts-reachable` | `expectPublishedOnly: true` and `collections` | A request that asks for drafts, with the token you gave Gaugeline, is answered with records the published list does not have. |

It asks nothing unless you set `expectPublishedOnly`, because a token that may preview drafts is a normal setup (a preview site needs one). It uses your own token against DatoCMS's own API, the same way every other read on this page does, so it does not need `--owner-consent`: it requests no non-public path and uses no key found on a site. Per collection, a finding is a count and at most five ids, never a field. If DatoCMS refuses the request that asks for drafts (HTTP 401 or 403) after answering the published one, the token cannot read drafts and the collection passes. If the request is accepted and nothing extra comes back, the check says could-not-check for that collection: nothing may be unpublished, and an empty answer is not proof.

## What cannot be checked

Anything the platform does not expose is could-not-check, with the reason, never a pass and never scraped from the platform's admin screens:

| Question                               | Answer here      | Why                                                                                                                                                          |
| -------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| The list of content types              | not offered      | The Content Delivery API has no list of types to ask, so you name each collection under `collections`. A type you do not name is not read.                   |
| Who has access to the project          | not offered      | Members are managed through the Content Management API, which a read-only token cannot use and Gaugeline does not call.                                      |
| Whether a page shows the same words    | not decided here | The adapter gives hashes; comparing them with the page is another check.                                                                                     |
| Records in other locales               | not read         | The adapter asks for the project's default locale only, the way a query with no locale argument does. `uncited`                                              |
| Whether a draft refusal means the flag | uncited          | DatoCMS's page on what a token without the preview flag is answered with was not read. A 401 or 403 is taken as a refusal; anything else is could-not-check. |
| A field that does not exist            | could-not-check  | A GraphQL query for a field the project does not have is an error, so a mistyped field in `fingerprint` is could-not-check, never a count of 0.              |

## When it cannot check

It never returns a list with a hole in it. The read is could-not-check, with the reason in plain words, when:

- `DATOCMS_TOKEN` is not set (nothing is asked), is not a plain token, or DatoCMS does not accept it (HTTP 401);
- `DATOCMS_ENVIRONMENT` is not a plain name (nothing is asked and the token is not sent);
- the token lacks access to the Content Delivery API (HTTP 403);
- no `collections` are named, or a type is asked for that is not named;
- a collection or field name is not a plain GraphQL name (nothing is asked), or DatoCMS answers with GraphQL errors (the messages are not repeated, because they can quote content);
- an answer is not the shape the platform sends, or a record has no id or no update time;
- a collection is bigger than the bound, a page is too big even at 10 records, or the list changes while it is read.

A platform that asks Gaugeline to slow down (HTTP 429) is waited for once when it says how long and the wait is a minute or less; after that the run keeps what it had read and says it is partial.

## What is bounded

| Limit                            | Value  |
| -------------------------------- | ------ |
| Records in one page of a list    | 100    |
| Most records DatoCMS gives once  | 500    |
| Records read from one collection | 10,000 |
| Ids named in a finding           | 5      |

There are no flags to raise them.

## Settings

| `gaugeline.adapters.json` field  | What it does                                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `adapters[].id`                  | `datocms`.                                                                                                |
| `adapters[].collections`         | The GraphQL collection of each content type, and the field that holds the slug. Plain GraphQL names only. |
| `adapters[].expectPublishedOnly` | The token is meant for published content only. Switches on `datocms-drafts-reachable`.                    |
| `adapters[].fingerprint`         | Fields to hash, by type. Up to 20 per type. A dotted name such as `seo.title` asks for the nested field.  |
| `adapters[].urls`                | Where a type's pages live: a path or an https address. Only `{slug}` and `{id}` are filled in.            |

| Environment variable  | What it is                                                                                                 |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `DATOCMS_TOKEN`       | The API token: Content Delivery API on, draft access off, Content Management API off.                      |
| `DATOCMS_ENVIRONMENT` | Optional. A sandbox environment name, sent as `X-Environment`. Without it the primary environment is read. |

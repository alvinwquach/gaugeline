# Hygraph: content checks for sites built on Hygraph

What a Hygraph project says is published, against what the live site shows, and whether an entry that was never published still has a page. Gaugeline only reads, through Hygraph's Content API, with a permanent auth token that has the narrowest access Hygraph offers.

## What this adapter reads, and the narrowest key

**The key first.** Hygraph's Content API is a GraphQL API with one endpoint per project and environment. A **permanent auth token** is what a program sends in an `Authorization: Bearer` header, and its permissions are set per model and per stage [docs]. Hygraph has two content stages, `DRAFT` (where all content starts) and `PUBLISHED`, and a token has a default stage [docs]. The narrowest token for Gaugeline is one with **read permission on the `PUBLISHED` stage of the models you name, and no create, update, delete or publish permission, and no Management API access**. Gaugeline's key kind for Hygraph is `read-only`: with such a token a program can read published entries and cannot change, publish or delete anything. Every query Gaugeline sends names `stage: PUBLISHED` itself, so a token whose default stage is `DRAFT` still gets the published list from the shared reads.

This page lists what the adapter reads, a worked example for a freelancer's client, what the check finds, what could not be checked and why, and what Gaugeline will not do. See [Content systems](/docs/integrations/) for the interface every adapter shares.

**A note on sources.** Documentation checked on: 2026-11-11. Hygraph's own documentation site (hygraph.com/docs) could not be reached when this page was written, so no page of it was opened. What is cited [docs] comes from Hygraph's own public source, read on that date: the generated GraphQL schema in `hygraph/hygraph-examples` (the `with-houdini` example: the `Stage` enum with `DRAFT` and `PUBLISHED`, the `stage: Stage! = PUBLISHED` default on every collection field, `first` and `skip`, the `orderBy: id_ASC` value, the `Connection` type with `aggregate { count }`, and the system fields `id`, `createdAt`, `updatedAt` and `publishedAt`, which is null on a draft), the endpoint addresses in that repository and in `hygraph/hygraph-astro-loader` and `hygraph/gatsby-source-graphcms` (two shapes: `https://api-eu-central-1.hygraph.com/v2/PROJECT/master` and `https://ap-south-1.cdn.hygraph.com/content/PROJECT/master`), and `Authorization: Bearer` from `hygraph/remix-preview-mode`. What is `uncited`: the exact permission names a token can have, that a token limited to `PUBLISHED` is refused the `DRAFT` stage and how (an HTTP status or a GraphQL error: the adapter treats both the same way), the largest `first` Hygraph accepts (the adapter never asks for more than 1000 and usually 100), any limit on `skip` (the adapter reads at most 5,000 entries of a model so it never needs a large one) and the rate-limit headers. The allowlist entries for the endpoints are recorded as not verified (`checked: null`) for the same reason. Check this page against Hygraph's current documentation before relying on a detail.

## What it reads

Every request is a GraphQL **query**, sent as a `POST` to the endpoint in `HYGRAPH_ENDPOINT`, because the Content API takes its queries that way. It is the one exception to "Gaugeline only sends `GET` and `HEAD`" that [ADR-0006](https://github.com/alvinwquach/gaugeline/blob/main/docs/adr/0006-read-only-post-queries.md) allows: the request goes through `fetcher.query` only, to one of two registered allowlist entries (`hygraph-content-api` for `/v2/*/*` and `hygraph-content-cdn` for `/content/*/*`), with the host the person set, and a body that must parse as one `query` document. A `mutation`, a `subscription`, a second operation, any other host and any other path is refused before anything is sent. The endpoint is checked first: only `https`, a `hygraph.com` host of the form `api-REGION.hygraph.com` or `REGION.cdn.hygraph.com`, a path of the form `/v2/PROJECT/ENVIRONMENT` (with an `api-` host) or `/content/PROJECT/ENVIRONMENT` (with a `.cdn.` host), and no credentials, port, query string or fragment. Anything else is could-not-check and the token is not sent.

| Query                                                                                          | What for                                                                                                                                                                                    |
| ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `query Page { pages(first: 100, skip: 0, stage: PUBLISHED, orderBy: id_ASC) { id slug ... } }` | The published entries of a model you named: counts, fingerprints and field counts. The model is the one you name under `collections`; the fields are the ones you name under `fingerprint`. |
| the same with `id` only                                                                        | The size of a model (`types()`), and the ids the draft check subtracts.                                                                                                                     |
| the same with `stage: DRAFT`, asking `id` and the slug field only                              | Only with `--owner-consent` and `readDraftStage`: which entries are not published. No field of a draft is ever asked for.                                                                   |

The first page of every list also asks the model's count (`pagesConnection(stage: PUBLISHED) { aggregate { count } }`): a list that ends with another number of entries than the count said, or a count over the bound, is could-not-check. Every page asks for an explicit order (`orderBy: id_ASC`). A page is at most 100 entries and never more than 1000. The next page is asked for with `skip`, stepping by the number of entries that came back, and a page shorter than the page asked for is the end of the list. A page that is too big for Gaugeline's size limit is asked again with half as many entries, down to 10, and only then is the model could-not-check. An entry that shows up on two pages means the list moved while it was read, and the read is could-not-check rather than a count of a shifting list. When Hygraph answers 429 with a short `Retry-After`, Gaugeline waits once and goes on; after that it keeps what it read and says the result is partial.

Gaugeline does not ask Hygraph to list its models, so you name them. Each entry under `collections` gives the model's plural API ID (`pages` for the model `Page`, as Hygraph names it in your project's schema) and, if you want addresses, the field that holds the slug.

## Make the key

In Hygraph, open the project's Settings, then API Access, and make a new permanent auth token for Gaugeline: give it read permission on the `PUBLISHED` stage of the models you will name, and nothing else. Copy the Content API endpoint from the same page (it names the project and the environment). Put both in the environment where Gaugeline runs, never in a file you commit:

```text
HYGRAPH_ENDPOINT=https://api-eu-central-1.hygraph.com/v2/PROJECT/master
HYGRAPH_TOKEN=the permanent auth token
```

The token goes in an `Authorization: Bearer` header and never in an address, it is sent only to the validated endpoint, a redirect is never followed, and every message, finding and report has it blanked.

### What reaches your computer

Gaugeline asks for exactly the fields it needs: `id`, `updatedAt`, `publishedAt`, the slug field you named, and the fields you list under `fingerprint`. Field values are used for exactly two things: counting which entries have a field and hashing the fields the settings name. The adapter keeps no value, and nothing but the short hash is printed, logged or put in a finding or report. With no `fingerprint` in the settings, no field value is read at all. The draft check asks for ids and slugs only.

## Example: a pop-up bakery on Hygraph

Pennywhistle Bakehouse is an invented pop-up bakery. A freelancer built its site on Hygraph and Next.js: pages (home, menu, one page each) and events (the Saturday market, a harbour pop-up). The owner edits the content from her phone and is putting a winter supper club together; the tickets are not announced, so the page is saved and not published. The freelancer's front end has a preview mode, and he wants to be sure the live build reads the `PUBLISHED` stage only. For the second question he gives Gaugeline a token that may read `DRAFT`, sets `readDraftStage`, and runs with `--owner-consent` on his client's project.

Settings go in `gaugeline.adapters.json` in the project folder. Nothing in it is a key.

```json title=gaugeline.adapters.json
{
  "adapters": [
    {
      "id": "hygraph",
      "collections": {
        "pages": {
          "collection": "pages",
          "slug": "slug"
        },
        "events": {
          "collection": "events",
          "slug": "slug"
        }
      },
      "readDraftStage": true,
      "fingerprint": {
        "pages": ["title", "summary"]
      },
      "urls": {
        "pages": "/{slug}",
        "events": "/events/{slug}"
      }
    }
  ]
}
```

What the adapter reads over that project, with a live site that has a page the supper club should not have (a test compares this output with the tool, so it cannot drift). The `draft stage` and `findings` lines are what the draft check reads when you pass `--owner-consent` and set `readDraftStage`; without them nothing is asked for the `DRAFT` stage:

```json title=Output
{
  "types": [
    {
      "name": "events",
      "count": 2
    },
    {
      "name": "pages",
      "count": 2
    }
  ],
  "page fields": {
    "title": 2,
    "summary": 1,
    "seo.title": 1
  },
  "a type that does not exist": "The type \"none\" is not named under \"collections\" in gaugeline.adapters.json, so it was not read.",
  "published pages": [
    {
      "id": "cm1page000000000home001",
      "type": "pages",
      "url": "/home",
      "slug": "home",
      "publishedAt": "2026-10-01T09:00:00.000Z",
      "updatedAt": "2026-10-20T08:30:00.000Z",
      "fieldHashes": {
        "title": "10a822cfa6c52dd7",
        "summary": "e6964c4ec7fd3d0b"
      }
    },
    {
      "id": "cm1page000000000menu002",
      "type": "pages",
      "url": "/menu",
      "slug": "menu",
      "publishedAt": "2026-10-05T09:00:00.000Z",
      "updatedAt": "2026-11-02T17:00:00.000Z",
      "fieldHashes": {
        "title": "505361d894328704"
      }
    }
  ],
  "draft stage": [
    "events: read, 2 published, 0 not published",
    "pages: read, 2 published, 1 not published (winter-supper-club)"
  ],
  "findings": [
    "hygraph-draft-live: pages: winter-supper-club is not published in Hygraph and /winter-supper-club answers 200 on the live site"
  ]
}
```

Read it the way the freelancer does. The published list has two pages and two events, and each page has an address the live site should answer. The menu page has no summary, so its `summary` hash is missing rather than hashed as empty. The important line is the finding: the `DRAFT` stage has a third page, `winter-supper-club`, that the `PUBLISHED` stage does not, and the live site answers 200 at `/winter-supper-club`. The front end is building pages from the `DRAFT` stage, so anyone who finds the address can read the unannounced supper club. The freelancer switches the live build to `stage: PUBLISHED` (or to a token whose default stage is `PUBLISHED`) and rebuilds.

The text of the client's pages never appears in a report: only counts, ids, slugs, dates and short hashes.

## The check

| Check                | Needs                                                    | What it finds                                                                                       |
| -------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `hygraph-draft-live` | `--owner-consent`, `readDraftStage: true`, `collections` | An entry in the `DRAFT` stage and not in the `PUBLISHED` stage whose page answers on the live site. |

**`hygraph-draft-live` is a probing check.** It asks Hygraph for the `DRAFT` stage with the token you gave Gaugeline, so it is off unless you pass `--owner-consent` (or put the consent in `gaugeline.consent.json`) **and** set `readDraftStage: true`, and you should run it only on sites you own or have permission to test. Without consent the report lists it under could-not-check with "not asked", never as a pass. Active testing of a site is outside what Gaugeline does: the check reads the CMS you gave it a token for, and asks the live site for each page with one `GET`.

**It needs a token that can read `DRAFT`.** The narrow token this page recommends for reading is limited to `PUBLISHED`, and Hygraph will not give it the `DRAFT` stage. When that happens the check says could-not-check for the model ("the DRAFT stage was refused or errored": Gaugeline reads HTTP 401 or 403 and a GraphQL error alike): it does not know which entries are unpublished, and not knowing is not a pass. To run the check, give Gaugeline a token that may read `DRAFT` for the run, on a project you own.

Per model, the unpublished entries are the ids in the `DRAFT` list that are not in the `PUBLISHED` list (held in a Set, so order and repeats do not matter). If there are any, the `PUBLISHED` list is read once more, and a list that changed in between is could-not-check. Each unpublished entry's address comes from the `urls` pattern for its type and its slug; an entry with no pattern, no slug, or the same slug as a published entry (a live page there would be the published one) is could-not-check for that entry. Then one `GET` of that page on the checked site's own host, at most 40 pages a run (the rest are could-not-check). A final 2xx answer is the finding, 404 or 410 passes for that entry, and any other answer is could-not-check for that page. The `DRAFT` stage holds every published entry, so a `DRAFT` list that lacks a published entry (a token limited to `PUBLISHED` may be given an empty list instead of an error, `uncited`) is not the `DRAFT` stage: it is could-not-check, never "nothing is unpublished". A refusal after the first page of the `DRAFT` list is could-not-check, never "refused". At most 40 unpublished entries are listed for a model (and only entries with a plain id); any more are could-not-check with their number, never silently left out. A page that answers through a redirect to another path (an unpublished slug that redirects to the home page) is could-not-check, not a finding; a redirect that only adds or removes a trailing slash is the same page. An entry published or unpublished between the two reads can leave a slightly stale answer for that run; the published list is read again when something is found to catch most of it. A finding shows the model, the entry's slug or id, the path and the status, never a field.

## What cannot be checked

Anything the platform does not expose is could-not-check, with the reason, never a pass and never scraped from the platform's admin screens:

| Question                             | Answer here      | Why                                                                                                                                             |
| ------------------------------------ | ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| The list of models                   | not offered      | Gaugeline does not ask Hygraph to list its models, so you name each model under `collections`. A model you do not name is not read.             |
| Who has access to the project        | not offered      | Members are managed through the Management API, which a read-only token cannot use and Gaugeline does not call.                                 |
| Whether a page shows the same words  | not decided here | The adapter gives hashes; comparing them with the page is another check.                                                                        |
| Entries in other locales             | not read         | The adapter asks with no `locales` argument, so Hygraph's default locale is read. `uncited`                                                     |
| Entries in other stages than the two | not read         | A project can add stages. Gaugeline asks `PUBLISHED`, and `DRAFT` only for the check. `uncited`                                                 |
| Scheduled publishing                 | not read         | An entry scheduled to publish is in `DRAFT` until then, and shows as unpublished. `uncited`                                                     |
| A field that does not exist          | could-not-check  | A GraphQL query for a field the project does not have is an error, so a mistyped field in `fingerprint` is could-not-check, never a count of 0. |

## When it cannot check

It never returns a list with a hole in it. The read is could-not-check, with the reason in plain words, when:

- `HYGRAPH_TOKEN` is not set (nothing is asked), is not a plain token, or Hygraph does not accept it (HTTP 401);
- `HYGRAPH_ENDPOINT` is not set or is not a Hygraph Content API address (nothing is asked and the token is not sent);
- the token lacks read permission on the model or stage (HTTP 403, or a GraphQL error: the messages are not repeated, because they can quote content);
- no `collections` are named, or a type is asked for that is not named;
- a model or field name is not a plain GraphQL name (nothing is asked);
- an answer is not the shape the platform sends, or an entry has no id or no update time;
- a model is bigger than the bound, a page is too big even at 10 entries, or the list changes while it is read.

A platform that asks Gaugeline to slow down (HTTP 429) is waited for once when it says how long and the wait is a minute or less; after that the run keeps what it had read and says it is partial.

## What is bounded

| Limit                                 | Value |
| ------------------------------------- | ----- |
| Entries in one page of a list         | 100   |
| Most entries asked for at once        | 1,000 |
| Entries read from one model and stage | 5,000 |
| Pages of the live site asked in a run | 40    |

There are no flags to raise them.

## Settings

| `gaugeline.adapters.json` field | What it does                                                                                                  |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `adapters[].id`                 | `hygraph`.                                                                                                    |
| `adapters[].collections`        | The model's plural API ID for each content type, and the field that holds the slug. Plain GraphQL names only. |
| `adapters[].readDraftStage`     | Lets `hygraph-draft-live` read the `DRAFT` stage (ids and slugs). It also needs `--owner-consent`.            |
| `adapters[].fingerprint`        | Fields to hash, by type. A dotted name such as `seo.title` asks for the nested field.                         |
| `adapters[].urls`               | Where a type's pages live: a path or an https address. Only `{slug}` and `{id}` are filled in.                |

| Environment variable | What it is                                                                                                 |
| -------------------- | ---------------------------------------------------------------------------------------------------------- |
| `HYGRAPH_ENDPOINT`   | The project's Content API endpoint. Not a key. Only a hygraph.com address of the two known shapes is used. |
| `HYGRAPH_TOKEN`      | A permanent auth token with read permission on the `PUBLISHED` stage of the models you name.               |

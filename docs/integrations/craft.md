# Craft CMS: content checks for sites built on Craft CMS

What a Craft CMS site's CMS says is live, against what the live pages show. Gaugeline reads Craft's GraphQL API with queries only, never a mutation, sent as GET requests, with a GraphQL schema token whose schema allows queries and nothing else.

## What this adapter reads, and the narrowest key

**The key first.** Craft gives GraphQL clients a _schema token_. A schema is a list of what a token may query (or change), and you choose it: for Gaugeline make a private schema that ticks only the **Query** permission of the sections you want checked (and nothing under **Mutate** or **Save**), then a token for that schema. Craft's documentation says a schema token is checked against its schema, that a token for a schema that allows mutations is "effectively as dangerous as a user with the equivalent permissions", and that the public schema is off until you turn it on. With a query-only schema, a program can read what you ticked and it cannot change or delete anything. Gaugeline's key kind for Craft CMS is `read-only`.

Gaugeline checks this instead of trusting you: before it reads any entry it sends one introspection query (`{ __schema { mutationType { name } } }`). If the schema behind the token shows a mutation type, the token can write, and Gaugeline refuses to use it and says so: for that site, use the live-site checks only. If introspection is switched off the check cannot be made, and the read goes on (every request Gaugeline sends is a query either way): make the schema query-only. A user's OAuth or personal access token (Craft 5.12 and later) is sent the same way; give it the `graphql:read` scope only, never `graphql:write`. A request with no token is a visitor's and is answered from Craft's public schema, if you enabled one.

This page lists what the adapter reads, a worked example for a freelancer's client, what it could not check and why, and what Gaugeline will not do. See [Content systems](/docs/integrations/) for the interface every adapter shares.

**A note on sources.** Documentation checked on: 2026-11-11, by reading Craft's [GraphQL API guide](https://github.com/craftcms/docs/blob/main/docs/5.x/development/graphql.md) (the source of craftcms.com/docs/5.x/development/graphql) from its GitHub repository, because craftcms.com itself could not be reached from the build machine. Details the guide does not state are marked `uncited`. Check this page against the current documentation before relying on a detail. [docs]

## What it reads

Every request is a `GET` to the GraphQL route in `CRAFT_URL` (for example `https://cms.fernlight.example/api`, or the always-available `/index.php?action=graphql/api`), through the same fetcher as every other request, with the query in the `query` parameter: the GET form Craft's guide documents under "Sending Requests Manually". Nothing else is ever sent. Craft accepts variables only on a POST, so the few values a query needs (a section handle, a site handle, a page size and an offset) are written into the query text, and only after they passed a strict check: section and site handles are letters, digits and underscores, and numbers are whole numbers Gaugeline made itself. Nothing from an answer is ever written into a later query.

| Query                                                            | What for                                                                                                                                                                                                                                                                       |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `__schema { mutationType { name } }`                             | Whether the token's schema can write (introspection). `uncited`: that Craft shows no mutation type to a schema with no mutation permission.                                                                                                                                    |
| `entryCount(section, site, status)`                              | How many entries a section has, [documented](https://github.com/craftcms/docs/blob/main/docs/5.x/development/graphql.md#the-entrycount-query) with the same arguments as `entries`.                                                                                            |
| `entries(section, site, status, orderBy, limit, offset) { ... }` | The entries: `id`, `slug`, `uri`, `url`, `siteHandle`, `status`, `dateUpdated`, `postDate` (fields of Craft's [`EntryInterface`](https://github.com/craftcms/docs/blob/main/docs/5.x/development/graphql.md#the-entryinterface-interface)), plus the fields the settings name. |

`site: "*"` asks for every site of the install, so an entry that exists on two sites is two items (`101.studio` and `101.atelier`: the element id and the site handle). `status: ["live"]` is Craft's status for an entry that is enabled, enabled for the site, posted and not expired. `uncited`: the exact meaning of `live` and the order `"id asc"` come from Craft's element query reference, which is not in the GraphQL guide.

Entries are read a page at a time. Pages are stepped by the number of entries each answer returned, and the total is read again with every page. A page that is too big is asked again with half as many entries, down to 10, and only then is the section could-not-check. A page that comes back short is not taken for the end of the list; one that comes back empty before the total is could-not-check; so are a page longer than the one asked for, an entry that appears twice, and a list longer than the bound, whatever total the server claims. When Craft answers 429 with a short `Retry-After`, Gaugeline waits once and goes on; after that it keeps what it read and says the result is partial.

## Make the key

In the Craft control panel (this takes an admin account, and `allowAdminChanges` on, because schemas are project config):

1. Open **GraphQL**, then **Schemas**, then **New schema**. Name it for Gaugeline.
2. Under **Entries**, tick **View** for each section you want checked. Tick nothing under **Save**, **Delete** or any other mutation permission.
3. Open **Tokens**, then **New token**, pick that schema, and copy the token.
4. Put both in the environment where Gaugeline runs, never in a file you commit:

```text
CRAFT_URL=https://cms.fernlight.example/api
CRAFT_TOKEN=<the schema token>
```

`CRAFT_URL` must be an https address with no user name or password: the token is never sent over plain http. The token goes in an `Authorization: Bearer` header and never in an address, it is sent only to the origin of `CRAFT_URL` (a redirect to another origin or to plain http is followed without it), and every message, finding and report has it blanked.

### What reaches your computer

Craft sends the fields a query asks for, so Gaugeline asks for ids, slugs, addresses, statuses and dates, and for a field's value only when the settings name it. Field values are used for exactly two things: counting which entries have a field and hashing the fields the settings name. The adapter keeps no value, and nothing but the short hash is printed, logged or put in a finding or report. With no `fingerprint` in the settings, nothing is hashed at all.

To name a field, write its handle for a field every entry has (`title`), or the entry type's GraphQL type and the handle for a custom field (`project_Entry.summary`; the type is `<entry type handle>_Entry`, as the guide's `post_Entry` example shows).

## Example: an architecture studio on a two-site Craft install

Fernlight Architects is an invented studio of six people. A freelancer built its site on Craft CMS: an English site for clients (`studio`) and a French one for its work in Quebec (`atelier`), on two domains from one install, with projects, journal posts and team members. The studio edits the journal between site visits. The freelancer wants to know that every entry that is live for a site has a page on that site, and not to be told off for pages that belong to the other site.

Settings go in `gaugeline.adapters.json` in the project folder. Nothing in it is a key. Craft lists its sections only to a schema that opted in (5.12 and later), so you name them, under `urls` or `fingerprint`:

```json title=gaugeline.adapters.json
{
  "adapters": [
    {
      "id": "craft",
      "fingerprint": {
        "projects": ["title", "project_Entry.summary"],
        "journal": ["title"],
        "team": ["title"]
      }
    }
  ]
}
```

What the adapter reads over the invented install, and what the check finds on the studio site, where the journal post `award-shortlist` was enabled in Craft and the front end never built its page (a test compares this block with the tool):

```json title=Output
{
  "live entries by section (every site counted)": [
    {
      "name": "journal",
      "count": 2
    },
    {
      "name": "projects",
      "count": 3
    },
    {
      "name": "team",
      "count": 2
    }
  ],
  "project fields": {
    "title": 3,
    "project_Entry.summary": 1
  },
  "drafts reachable": true,
  "live projects": [
    {
      "id": "101.studio",
      "type": "projects",
      "url": "https://fernlight-studio.example/projects/harbour-library",
      "slug": "harbour-library",
      "publishedAt": "2026-10-01T16:00:00.000Z",
      "updatedAt": "2026-10-20T15:30:00.000Z",
      "fieldHashes": {
        "title": "f202aff908faf0bd",
        "project_Entry.summary": "9108c9f382354084"
      }
    },
    {
      "id": "101.atelier",
      "type": "projects",
      "url": "https://fernlight-atelier.example/projets/bibliotheque-du-port",
      "slug": "bibliotheque-du-port",
      "publishedAt": "2026-10-01T16:00:00.000Z",
      "updatedAt": "2026-10-21T15:30:00.000Z",
      "fieldHashes": {
        "title": "e61de35bc56c087d"
      }
    },
    {
      "id": "102.studio",
      "type": "projects",
      "url": "https://fernlight-studio.example/projects/tidal-baths",
      "slug": "tidal-baths",
      "publishedAt": "2026-10-05T16:00:00.000Z",
      "updatedAt": "2026-11-03T00:00:00.000Z",
      "fieldHashes": {
        "title": "b9b9a0af5ef2c63b"
      }
    }
  ],
  "pages asked for on the studio site": [
    {
      "entry": "201.studio",
      "path": "/journal/site-visit-notes",
      "answer": 200
    },
    {
      "entry": "202.studio",
      "path": "/journal/award-shortlist",
      "answer": 404
    },
    {
      "entry": "101.studio",
      "path": "/projects/harbour-library",
      "answer": 200
    },
    {
      "entry": "102.studio",
      "path": "/projects/tidal-baths",
      "answer": 200
    },
    {
      "entry": "301.studio",
      "path": "/team/ana",
      "answer": 200
    },
    {
      "entry": "302.studio",
      "path": "/team/ben",
      "answer": 200
    }
  ],
  "entries on the other site, not counted": 1,
  "findings": [
    "journal: award-shortlist is live in Craft for the studio site and /journal/award-shortlist answers 404"
  ]
}
```

The freelancer reads it from the top. Seven live entries across three sections (counted on both sites). `drafts reachable` is true: the key can see entries that are not live (a project switched off for the French site, and a draft), so it is worth being sure the token is not shared. The hashes show the French project has a title and no summary, and the English one has both. Six pages were asked for on the studio site, and one answers 404: the award shortlist post is live in Craft and has no page. The one French project page was not asked for: it belongs to the `atelier` site, so it is checked when the run is for that site's address.

## The check

| Check                 | What it finds                                                                                                                 |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `craft-entry-no-page` | An entry that is live in Craft for a site, whose page answers 404 or 410 on that site's live pages. See the checks reference. |

How a multi-site install is told apart: each entry's own `url` (Craft builds it from the site's base URL) names its site's domain. An entry whose page is on another domain is counted for that domain's site and not for this one, and is never asked for. Two Craft sites on one domain with different path prefixes cannot be told apart this way: name the Craft site handle when you check, and only that site is read. A section for a headless front end, whose Craft addresses point at the CMS, takes a `urls` pattern (`"journal": "/journal/{slug}"`), which wins over Craft's own address; a pattern does not know which site an entry is on, so name the site handle with it on an install with more than one site. A section with neither is could-not-check by name, never guessed.

## What cannot be checked

Anything the platform does not expose is could-not-check, with the reason, never a pass and never scraped from the control panel:

| Question                                | Answer here                | Why                                                                                                                                        |
| --------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Which sections the install has          | you name them              | Craft lists sections to a token only through the optional "Query for sections" component (5.12 and later). `uncited` for earlier versions. |
| A section the schema does not include   | looks empty                | Craft answers an empty list, not "forbidden". A section with no live entry is could-not-check, never a pass.                               |
| Who has access to the site (`members`)  | not offered                | A schema token cannot list users without a Users permission, which Gaugeline does not ask for.                                             |
| Whether a page shows the same words     | not decided here           | The adapter gives hashes; comparing them with the page is another check.                                                                   |
| Drafts, revisions and entries of a user | not read                   | Craft shows drafts and revisions only to users with control panel access, so a schema token never sees them.                               |
| Whether the token can write             | when introspection answers | A schema with introspection off cannot be inspected: make it query-only.                                                                   |

## When it cannot check

It never returns a list with a hole in it. The read is could-not-check, with the reason in plain words, when:

- `CRAFT_URL` is not set, is not an address, or is not https (nothing is asked);
- the schema behind the token allows mutations (nothing else is asked), or Craft does not accept the token (it answers a 400-level error to an invalid token, as the guide says, and 401 or 403 when a schema does not allow a read);
- Craft answers a GraphQL `errors` list with a 200 status (usually a section or field the schema does not include): the messages are not repeated, because they can quote content;
- an answer is not the shape Craft sends, or an entry has an id that is not an id, no site handle or no update time;
- a section is bigger than the bound, a page of entries is too big even at 10 entries, the list stops before its total, a page is longer than asked for, or an entry appears twice;
- an entry has no address, or its address is not a plain path on the site (`//host`, `https://`, `..`, an encoded slash or dot, a control character), and no pattern gives it one.

A platform that asks Gaugeline to slow down (HTTP 429) is waited for once when it says how long and the wait is a minute or less; after that the run keeps what it had read and says it is partial.

## What is bounded

| Limit                           | Value  |
| ------------------------------- | ------ |
| Entries in one page of a list   | 100    |
| Entries read from one section   | 10,000 |
| Live pages asked for in one run | 300    |

There are no flags to raise them.

## Settings

| `gaugeline.adapters.json` field | What it does                                                                                                                                   |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapters[].id`                 | `craft`.                                                                                                                                       |
| `adapters[].fingerprint`        | Fields to hash, by section handle: `title`, or `<entry type handle>_Entry.<field handle>`. Names the sections too.                             |
| `adapters[].urls`               | Where a section's pages live, when Craft's own address is not the front end's. Only `{slug}` and `{id}` are filled in. Names the sections too. |

| Environment variable | What it is                                                                                        |
| -------------------- | ------------------------------------------------------------------------------------------------- |
| `CRAFT_URL`          | The GraphQL route (https). Not a key.                                                             |
| `CRAFT_TOKEN`        | The key: a schema token whose schema allows queries only. Optional: with none, the public schema. |

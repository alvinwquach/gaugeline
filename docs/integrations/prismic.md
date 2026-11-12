# Prismic: content checks for sites built on Prismic

What a Prismic repository says is published, against what the live site shows, whether the public cache of the repository serves the master ref the origin has, and (only with your consent) whether a release holds an older copy of a document than the one that is live. Gaugeline only reads, through Prismic's Document API, with no key at all for a public repository and a read access token for a private one.

## What this adapter reads, and the narrowest key

**The key first.** A public Prismic repository needs **no key**: its Document API answers anyone, and Gaugeline asks for nothing more. A private repository needs a **read access token** (made under Settings, then API & Security, in the repository), which the Document API accepts to read what is published and the releases. Prismic describes the access token as the way to read a private repository's content [docs]; the page does not say that the token cannot write, but the Document API has no write endpoint (writes go through a separate Migration API with its own write token, which Gaugeline never uses and never asks for). Gaugeline's key kind for Prismic is `read-only`, and with no key at all for a public repository.

**Where the token goes.** Prismic's own client sends the access token as an `access_token` parameter **in the address** for the Document API [docs]. Gaugeline never puts a key in an address, because an address reaches logs, so it sends the token in an `Authorization: Token <token>` header instead, which Prismic's client uses for the GraphQL API [docs]. Whether the Document API accepts the header form is `uncited`: the build could not read Prismic's page. A private repository that answers 401 to the header form is therefore **could-not-check**, with a message that says so, never a pass. If that is your repository, the way forward is to make it public for the run or to wait for Prismic to document the header.

This page lists what the adapter reads, a worked example for a freelancer's client, what the checks find, what could not be checked and why, and what Gaugeline will not do. See [Content systems](/docs/integrations/) for the interface every adapter shares.

**A note on sources.** Documentation checked on: 2026-11-12. Prismic's own documentation (prismic.io/docs) could not be reached when this page was written, so no page of it was read. What is cited [docs] comes from Prismic's published npm package `@prismicio/client` 7.23.1, read on that date: the repository endpoint `https://<repository>.cdn.prismic.io/api/v2`, the repository name rule, the `documents/search` route and its parameters (`ref`, `q`, `page`, `pageSize` with a maximum of 100, `orderings`, `fetch`, `lang` with `*` for every language), the shape of the answer (`page`, `results_per_page`, `total_results_size`, `total_pages`, `results`), the refs (`ref`, `isMasterRef`, `label`, `scheduledAt`), the document header fields (`id`, `uid`, `type`, `lang`, `first_publication_date`, `last_publication_date`), the 404 and 410 answers for a ref that is gone, the `access_token` address parameter, the `Authorization: Token` header of the GraphQL route, and the non-CDN endpoint `https://<repository>.prismic.io/api/v2` that the client warns about. Everything else is `uncited`: that the origin host answers the same root, that an `Authorization: Token` header is accepted by the Document API, that a root lists releases only to a token, that the answer for a release ref is a document's own copy with its own `last_publication_date`, and the exact spelling of the two `orderings` Gaugeline sends. A wrong one shows up as an HTTP error or a list that does not add up and is could-not-check, never a pass. Check this page against Prismic's current documentation before relying on a detail.

## What it reads

Every request is a `GET` to `https://<repository>.cdn.prismic.io/api/v2` (the cache, where a site reads) or `https://<repository>.prismic.io/api/v2` (the origin), through the same fetcher as every other request. The repository name comes from `PRISMIC_REPOSITORY`; both host names are made from it and no other host is ever asked. Nothing else is ever sent.

| Request                                                                                                   | What for                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /api/v2`                                                                                             | The refs (the master ref, and the releases a token can see), the document types and the languages. Read on the cache, and on the origin for the master ref check.                                        |
| `GET /api/v2/documents/search?ref=<master>&lang=*&q=[[at(document.type, "classes")]]&pageSize=100&page=1` | The published documents of one type, in a fixed order (`orderings=[document.first_publication_date]`): counts, fingerprints and field counts. `fetch` names only the fields you put under `fingerprint`. |
| the same with `pageSize=1` and `orderings=[document.last_publication_date desc]`                          | The newest publication a ref shows (master ref check only, and only when the two hosts disagree).                                                                                                        |
| the same with a release's `ref` and the token in the header                                               | Only with `--owner-consent` and `checkReleases: true`: the documents a release lists, as ids, types and times.                                                                                           |

Every list is read at one fixed ref, so it is a snapshot that does not shift while it is read, and it has an explicit order. Each page is checked: it must be the page asked for, of the size asked for, with the same total and page count as the first; no document may appear twice; a page must hold exactly the documents expected there; and the list ends only when the number read equals the total the first page reported. Any other outcome, and a list over 10,000 documents, is could-not-check, never the end of the list. A page that is too big for Gaugeline's size limit is asked again with a smaller one (100, 50, 25, then 5), and only then is the list could-not-check. A ref that has expired or is gone (HTTP 404 or 410) while a list is read is could-not-check. When Prismic answers 429 with a short `Retry-After`, Gaugeline waits once and goes on; after that it keeps what it read and says the result is partial.

Documents are read in **every language** (`lang=*`), because the counts should include them. A document is given an address only if it is in the repository's main language (the root names it): the address pattern in your settings is for that language, and Gaugeline will not guess a locale prefix, so a document in another language is could-not-check for its page, never a missing one.

## The checks

| Check                           | Needs                                                    | What it finds                                                                                                                                       |
| ------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prismic-document-no-page`      | `urls` for the types that have pages                     | A document Prismic says is published whose page answers 404 or 410 on the live site.                                                                |
| `prismic-master-ref-stale`      | nothing                                                  | The public cache keeps naming an older master ref than the origin, and the origin's ref shows a newer publication.                                  |
| `prismic-release-document-live` | `--owner-consent` and `checkReleases: true`, and a token | A release lists a document whose copy in the release was last published before the live copy: publishing the release would put the older copy back. |

**`prismic-master-ref-stale`.** The master ref is the name of the repository's latest published content, and a site that asks the cache for it gets what the cache last saw. Gaugeline reads the root on both hosts. The same ref is a pass. Different refs are read again after six seconds (Prismic's own client keeps the ref for five), because a publication in flight makes them differ for a moment; the same two different refs on the second read are compared by the newest document each shows. A finding is made only when the origin's newest publication is later than the cache's. Two refs that differ with no newer document behind them (an unpublished document looks like this), or refs that keep changing across three reads, are could-not-check. The finding quotes two times and one document id, never a field.

**`prismic-release-document-live` is a probing check.** A release holds content that is not published, so reading it with your token is off unless you pass `--owner-consent` (or put the consent in `gaugeline.consent.json`) **and** set `checkReleases: true` in `gaugeline.adapters.json`, and you should run it only on sites you own or have permission to test. Without either, no release is read and the report lists the check under could-not-check with "not asked", never as a pass. For the master ref and each release (at most ten, ordered by id) Gaugeline lists the documents' ids, types and publication times at that ref. A document in a release whose last publication time is earlier than the same document's at the master ref is the finding. The refs are read again afterwards and, if the master ref or a release's ref moved while it was read, the reading starts over once; a second move is could-not-check. What Prismic returns for a document when it is asked at a release's ref is `uncited` (see the note on sources), so this comparison is the build's understanding: check it on a release of your own before relying on it. A finding names the release, the document ids (at most five) and their type, never a field.

## Make the key

Only for a private repository. In the Prismic repository open Settings, then API & Security, and make an access token for the Content API (not a write token). Put it in the environment where Gaugeline runs, with the repository's name, never in a file you commit:

```text
PRISMIC_REPOSITORY=<the repository name, such as larkspur-yoga>
PRISMIC_ACCESS_TOKEN=<the read access token; leave it out for a public repository>
```

`PRISMIC_REPOSITORY` is the name, not an address: letters, digits and hyphens, at least four characters. A value with a dot, a slash, a colon, an at sign, a space or a double hyphen is refused and nothing is asked. The token is sent only in an `Authorization` header to the two Prismic hosts made from that name over https, never in an address, a redirect to another host drops it, and every message, finding and report has it blanked. A published read is asked with **no token first**; only when the repository refuses it (HTTP 401 or 403) and a token is set is it asked again with the token, and every later read then sends it. The releases are always asked with the token, because a repository lists them only to a token. If you set a token and the repository is public, the token is therefore used only for the releases.

### What reaches your computer

A Prismic document list sends each document's whole content unless `fetch` narrows it. Gaugeline asks for `fetch` of exactly the fields you put under `fingerprint` for a type (and none otherwise). Field values are used for exactly two things: counting which documents have a field and hashing the fields the settings name. A rich text with one empty paragraph, an empty link and an empty image count as no value. The adapter keeps no value, and nothing but the short hash is printed, logged or put in a finding or report. With no `fingerprint` in the settings, no field is hashed.

## Example: a yoga studio on Prismic

Larkspur Yoga Studio is an invented small studio. A freelancer built its site on Prismic and Next.js: classes (one page each), teachers (one page each) and a few notices. The owner edits the content between classes and publishes from her phone, and she is putting an autumn retreat together in a release. The freelancer wants to know three things: that what Prismic says is published has a page on the site, that the site's cache is not holding an older version of the content, and that nobody has left the owner's release holding an older copy of a class than the one live, because publishing that release would quietly undo Thursday's change. For the third he gives Gaugeline a read access token and runs with `--owner-consent` on his client's repository.

Settings go in `gaugeline.adapters.json` in the project folder. Nothing in it is a key.

```json title=gaugeline.adapters.json
{
  "adapters": [
    {
      "id": "prismic",
      "fingerprint": {
        "classes": ["name", "summary"]
      },
      "urls": {
        "classes": "/classes/{slug}",
        "teachers": "/teachers/{slug}"
      },
      "checkReleases": true
    }
  ]
}
```

What the adapter reads over the invented repository (a test compares this block with the tool, so the page cannot drift from it; to print it again: `pnpm exec tsx packages/core/src/adapters/__tests__/prismic-docs-example.ts`):

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
  "a field count for a type that does not exist": {
    "name": 0
  },
  "published classes": [
    {
      "id": "c-morning",
      "type": "classes",
      "url": "/classes/morning-flow",
      "slug": "morning-flow",
      "publishedAt": "2026-10-01T09:00:00.000Z",
      "updatedAt": "2026-10-20T08:30:00.000Z",
      "fieldHashes": {
        "name": "c8873e07453b9b7c",
        "summary": "8eb7edac4f07da46"
      }
    },
    {
      "id": "c-evening",
      "type": "classes",
      "url": "/classes/evening-stretch",
      "slug": "evening-stretch",
      "publishedAt": "2026-10-05T09:00:00.000Z",
      "updatedAt": "2026-11-02T17:00:00.000Z",
      "fieldHashes": {
        "name": "895938af8429eca8"
      }
    }
  ],
  "master ref, cache against origin": {
    "state": "same"
  },
  "releases (token and consent)": [
    {
      "id": "rel-autumn",
      "label": "Autumn retreat",
      "state": "read",
      "documents": 6,
      "behind": [
        {
          "id": "c-evening",
          "type": "classes"
        }
      ]
    }
  ]
}
```

The freelancer reads it like this. The repository has three types: two classes, one notice and two teachers. Of the two classes both have a name and one has a summary: the evening stretch's summary is an empty paragraph, which is how Prismic stores "nothing here", so it does not count. The evening stretch changed on 2 November (its `updatedAt`), and its hashes are what a later run compares to learn that its words changed. The cache and the origin agree on the master ref, so the site is not behind. And the autumn release lists six documents, one of which, `c-evening`, was last published in the release before the copy that went live on 2 November: publishing the release would put the old evening stretch back. The words of the classes never appear in the output: only counts, ids, slugs, dates and short hashes.

## What cannot be checked

Anything the platform does not expose is could-not-check, with the reason, never a pass and never scraped from the platform's admin screens:

| Question                                                                    | Answer here      | Why                                                                                                                                                              |
| --------------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A private repository whose Document API takes the token only in the address | could-not-check  | Gaugeline never puts a key in an address, and the header form is `uncited`. The message says so.                                                                 |
| The Prismic GraphQL API                                                     | not used         | It needs the schema of your types and, for a private repository, a ref from the root; the Document API gives the same facts without either.                      |
| Which documents a release changes                                           | not offered      | A release is read through its ref, which gives documents, not a list of what the release changed. The release check compares publication times only (see above). |
| Who has access to the repository                                            | not offered      | Prismic does not list members to an access token.                                                                                                                |
| Whether a page shows the same words                                         | not decided here | The adapter gives hashes; comparing them with the page is another check.                                                                                         |
| A page for a document in another language                                   | could-not-check  | The address pattern is for the main language, and Gaugeline does not guess a locale prefix.                                                                      |
| A release scheduled for a time that has passed                              | not judged       | A release's `scheduledAt` is read and not used: whether a late release is stuck or about to publish cannot be told from the refs.                                |

## When it cannot check

It never returns a list with a hole in it. The read is could-not-check, with the reason in plain words, when:

- `PRISMIC_REPOSITORY` is not set or is not a repository name (nothing is asked);
- the repository is private and `PRISMIC_ACCESS_TOKEN` is not set, or Prismic does not accept the token in a header (HTTP 401 or 403);
- the root has no master ref, more than one, or a document type with a name that is not plain (letters, digits, underscores and hyphens);
- a document has no id, no type, no language, no usable publication time, or a `uid` that is neither text nor empty (a value of another kind is unknown, never "none");
- a page is not the page asked for, is of another size, holds a different number of documents than expected, repeats a document, or reports a total that moves; the list stops before its total; a ref expires (HTTP 404 or 410) while it is read;
- a list is bigger than the bound or a page is too big even at 5 documents.

A platform that asks Gaugeline to slow down (HTTP 429) is waited for once when it says how long and the wait is a minute or less; after that the run keeps what it had read and says it is partial.

## What is bounded

| Limit                                                 | Value  |
| ----------------------------------------------------- | ------ |
| Documents in one page of a list                       | 100    |
| Documents read from one type or one release           | 10,000 |
| Releases read in a run                                | 10     |
| Live pages asked for in a run                         | 300    |
| Reads of the root to tell a stale ref (seconds apart) | 3 (6)  |

There are no flags to raise them.

## Settings

| `gaugeline.adapters.json` field | What it does                                                                                                                    |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `adapters[].id`                 | `prismic`.                                                                                                                      |
| `adapters[].fingerprint`        | Fields to hash, by type. Up to 20 per type. A dotted name such as `seo.title` goes into the field.                              |
| `adapters[].urls`               | Where a type's pages live, for the main language: a path or an https address. Only `{slug}` (the uid) and `{id}` are filled in. |
| `adapters[].checkReleases`      | `true` lets Gaugeline read the repository's releases with the token (still only with `--owner-consent`). Default: off.          |

| Environment variable   | What it is                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------- |
| `PRISMIC_REPOSITORY`   | The repository's name. Not a key.                                                                 |
| `PRISMIC_ACCESS_TOKEN` | A read access token. Optional for a public repository; needed for a private one and for releases. |

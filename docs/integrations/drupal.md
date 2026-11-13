# Drupal: content checks for sites built on Drupal

What a Drupal site's CMS says is published, against what a visitor can open. Gaugeline only reads: it sends `GET` requests to Drupal's JSON:API and to the site's own pages, and nothing else.

## What this adapter reads, and the narrowest key

**The key first.** What is published needs **no key**: Drupal's JSON:API module serves published content to a visitor who is not logged in, and Gaugeline reads it as one, with no credential and no cookie. A credential is **optional** and used for one thing only: the probing check that lists nodes which are not published and asks whether a visitor can open them. For that, the narrowest credential is a **token, or a user name and password, of a dedicated user whose role can only view content**, and the check also needs `--owner-consent` and a `readUnpublished` entry in the settings. Gaugeline's key kind for Drupal is `read-only` (optional), and the narrowing is yours to make in the role: Gaugeline sends only `GET`, but it cannot make a credential weaker than the role behind it. Drupal's JSON:API is also read-only on the server side unless someone turns writing on (the module's `read_only` setting is on by default), and Gaugeline never asks for anything else.

**Say this plainly to the client.** Drupal core has no permission that lets a role view other people's unpublished nodes and do nothing else. In core the permissions that show unpublished nodes are `bypass node access` (shown as "Bypass content access control") and `view own unpublished content`, which covers only the user's own nodes. A role that can list every unpublished node therefore either holds the broad core permission or uses a contributed module that adds a view-only permission (the Drupal community's "View Unpublished" module is the usual one). Make the role for Gaugeline with the narrowest of these that works on your site, never an administrator's account, and know that the credential can read what that role can read. If you would rather not hand over such a credential, leave `readUnpublished` out: everything else on this page still works with no key.

This page lists what the adapter reads, a worked example for a freelancer's client, what it could not check and why, and what Gaugeline will not do. See [Content systems](/docs/integrations/) for the interface every adapter shares.

**A note on sources.** Documentation checked on: 2026-11-12. Drupal's own documentation site (`www.drupal.org`) could not be reached when this page was written (the build session's network policy refused it). What is confirmed is from the source of Drupal core's own JSON:API module, read from its public mirror [drupal/core on GitHub](https://github.com/drupal/core/tree/11.x/modules/jsonapi) [docs]: the module's `read_only` setting is on by default (`config/install/jsonapi.settings.yml`); a collection is paged with `page[limit]` and `page[offset]`, the page size is capped at 50 (`src/Query/OffsetPage.php`); the `next` link is built from the offset plus the page size, and a collection answer has no total unless a resource type says to include one, which core's resource type does not (`src/Controller/EntityResource.php`, `includeCount()` in `src/ResourceType/ResourceType.php`); `sort=id` is the entity's UUID (`src/Context/FieldResolver.php`); the node access rules named above are in the node module's `NodeAccessControlHandler.php`; and the Basic authentication module reads the user name and password the client sends (`basic_auth` module). Everything else on this page is from the build's knowledge of Drupal and is **uncited**: that `meta.count` is added by the contributed JSON:API Extras module, the field names `status`, `changed`, `created`, `path` and `drupal_internal__nid` on a node, that Drupal sends `X-Generator: Drupal 10 (https://www.drupal.org)` with its own answers and answers a visitor 403 for an unpublished node, that bearer tokens come from a contributed OAuth module, and the role and permission names. Each is pinned by Gaugeline's tests over invented answers, not confirmed against the live pages. Check them against the current Drupal docs before relying on a detail: [JSON:API module](https://www.drupal.org/docs/core-modules-and-themes/core-modules/jsonapi-module) [docs], [pagination](https://www.drupal.org/docs/core-modules-and-themes/core-modules/jsonapi-module/pagination) [docs], [filtering](https://www.drupal.org/docs/core-modules-and-themes/core-modules/jsonapi-module/filtering) [docs].

## What it reads

Every request is a `GET` to your `DRUPAL_URL`, through the same fetcher as every other request. A redirect is never followed with a credential, and a redirect answer to a JSON:API read is could-not-check.

| Endpoint                                | Key        | What for                                                                                                                                                                                                                                                                                        |
| --------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET /jsonapi/ENTITY/BUNDLE`            | none       | The published resources of a type you named: counts, fingerprints and field counts. Pages of up to 50 (`filter[status]=1`, `sort=id`, `page[limit]`, `page[offset]`), asking only for the fields needed (`fields[TYPE]`: the status, dates, path and the fields to hash).                       |
| `GET /jsonapi/node/BUNDLE`, unpublished | credential | Only with `--owner-consent` and `readUnpublished`: the node numbers of the nodes that are not published (`filter[status]=0`, the status, `drupal_internal__nid` and `path` only), and, for a node a visitor could open, one more look at the node by its id to confirm it is still unpublished. |
| `GET /node/NID`, no credential          | none       | Only with `--owner-consent` and `readUnpublished`: whether a visitor can open each unpublished node at its own address on the Drupal site. See [the check](#the-check).                                                                                                                         |

**Gaugeline does not ask Drupal to list its resource types.** You name the types to read, by their JSON:API name (the entity type and the bundle joined by two hyphens, such as `node--article`), as keys of `urls` or `fingerprint` in `gaugeline.adapters.json`. A type you do not name is not read. The JSON:API path is the default `/jsonapi`; a site that moved it is could-not-check with Drupal's 404.

**What "published" means.** A node is published when its `status` is `true`. The adapter asks Drupal for `filter[status]=1` and also checks each resource: one that says `false` is not counted, and one whose status is missing or is not `true` or `false` makes the read could-not-check, because whether it is published is not known. Nodes a visitor may not see are left out by Drupal itself.

Ids (UUIDs), node numbers, path aliases and times only are kept: a title, a body or a price is read to be counted or hashed and is never kept, printed or put in a finding. A node's address is its path alias when it has a plain one, else the pattern under `urls` (with `{id}` filled in) when there is one, else none. Fields are read from a node's attributes; a field that holds a reference to another item (an image, a term) is a relationship in JSON:API and is not read.

**How a list is read.** Drupal pages by an offset that grows by the page size asked, whatever number of resources the user may see on a page, so a page with fewer resources than asked for does not end the list. The end is the absence of a `next` link. The `next` link is built by the server, so it is never requested: it is read for the paging it states and must stay on the same host and path and state the offset this read expects. Gaugeline asks every page from its own address. Drupal core reports no total, so a list cannot be checked against one; it is checked for a resource listed twice, for a first page that differs when read again at the end (a list that changed under the read is could-not-check), for a count when the site reports one (`meta.count`, from the JSON:API Extras module), and for a bound. This catches most changes made while a list is read, not every one, and the page says so rather than claim more.

Rate limits: when Drupal answers 429 with a short `Retry-After`, Gaugeline waits once and goes on; after that it keeps what it read and says the result is partial.

## Make the credential

Skip this if you only want what is published read.

In Drupal's admin, make a role and a user for Gaugeline. Give the role the narrowest permission that lets it view unpublished nodes (see above), and nothing that edits, deletes or administers. Then enable one way to authenticate a JSON:API request:

- **A bearer token** from a contributed OAuth module such as Simple OAuth (uncited): put the access token in `DRUPAL_TOKEN`.
- **Basic authentication**, the `basic_auth` module that ships with core: put the user name in `DRUPAL_USER` and the password in `DRUPAL_PASSWORD`. Basic authentication sends the password with every request, so use it only over https, with a password made for this user and nothing else.

Put it in the environment where Gaugeline runs, never in a file you commit:

```text
DRUPAL_URL=https://www.fernlea-clinic.example
DRUPAL_TOKEN=<the access token of the view-only user>
```

Set one credential, not both. The credential goes in an `Authorization` header and never in an address, it is sent only to the Drupal address you configured, only over `https`, only for the unpublished read and the one more look, a redirect is never followed with it, and every message, finding and report has it blanked. A token or password with a space, a line break or a character that is not plain ASCII in it (a user name with a colon) is refused before anything is sent.

### What reaches your computer

The unpublished read asks for the status, the node number and the path alias of each unpublished node and nothing else: no title, no body, no field. The published read asks for the status, dates, path and the fields named under `fingerprint` (if Drupal answers 400 to that list, Gaugeline asks again for whole resources). Field values are used for exactly two things: counting which resources have a field and hashing the fields the settings name. The adapter keeps no value, and nothing but the short hash is printed, logged or put in a finding or report. With no `fingerprint` in the settings, nothing is hashed at all.

## Example: a village clinic on Drupal

Fernlea Family Clinic is an invented village clinic. A freelancer built its site on Drupal: news articles (a flu clinic, opening hours) and a few pages. The practice manager drafts announcements in Drupal and publishes them herself. The freelancer wants to know what Drupal says is live, and, before she does, whether a draft she has not published (a staff change, next year's price list) can be opened by anyone who types its address.

Settings go in `gaugeline.adapters.json` in the project folder. Nothing in it is a key. Naming a type under `fingerprint` also means it is read; `readUnpublished` lets the one probing check list the drafts.

```json title=gaugeline.adapters.json
{
  "adapters": [
    {
      "id": "drupal",
      "fingerprint": { "node--article": ["title", "field_subtitle"], "node--page": ["title"] },
      "readUnpublished": true
    }
  ]
}
```

With `DRUPAL_URL` and `DRUPAL_TOKEN` in the environment, this is what the adapter reads over the clinic's Drupal (invented: two of the articles and one page are published, the rest are drafts):

```json title=Output
{
  "types": [
    {
      "name": "node--article",
      "count": 2
    },
    {
      "name": "node--page",
      "count": 1
    }
  ],
  "article fields": {
    "title": 2,
    "field_subtitle": 1,
    "field_teaser": 0
  },
  "drafts reachable": "not-applicable",
  "published articles": [
    {
      "id": "5f1c0a10-0000-4000-8000-000000000001",
      "type": "node--article",
      "url": "/news/flu-jab-clinic",
      "publishedAt": "2026-10-20T10:00:00.000Z",
      "updatedAt": "2026-11-02T10:00:00.000Z",
      "fieldHashes": {
        "title": "05a13be5d76b3309",
        "field_subtitle": "d0af19adde498f9f"
      }
    },
    {
      "id": "5f1c0a10-0000-4000-8000-000000000002",
      "type": "node--article",
      "publishedAt": "2026-09-01T10:00:00.000Z",
      "updatedAt": "2026-10-01T10:00:00.000Z",
      "fieldHashes": {
        "title": "76d3d04a6486f8e5"
      }
    }
  ]
}
```

Read it the way the freelancer does. The clinic has two published articles and one published page, though Drupal holds more: the others are drafts. `drafts reachable` is `"not-applicable"`: the published read never asks for unpublished nodes, even with a credential set, so it has nothing to say about them. Listing them is the probing check's own read, below, and runs only with `--owner-consent`. The opening-hours article has no `field_subtitle`, so it has no hash for it (a field an item lacks is left out, never hashed as empty), and `field_teaser` counts 0 because no article has one. It has no path alias either, so it has no address. The hashes stand for the clinic's titles and subtitles, which are not in the output.

The check then runs over that site, with the owner's consent (invented: the staff-change article is a draft, and its page opens for a visitor):

```json title=Findings
{
  "findings": [
    {
      "check": "drupal-unpublished-reachable",
      "severity": "high",
      "evidence": "node--article: node 3 is not published in Drupal and /node/3 answers a visitor 200",
      "url": "https://fernlea-clinic.example/node/3"
    }
  ],
  "could not check": [],
  "passed": []
}
```

- **`drupal-unpublished-reachable`**: the article about staff changes is not published in Drupal, and `/node/3` answers a visitor with a page. The finding is a type, a node number and a status; no title is shown. The fix is in Drupal, under **People, then Permissions**: find which role (often Anonymous or Authenticated, through a permission from a contributed module) can view unpublished content, remove it, and clear the caches, so a page cache or a CDN does not keep serving the page.

## The check

It is in the [checks reference](/docs/checks) with what it catches, why it matters, how to fix it and a technical line.

| Check                          | Severity | Finds                                                                                                            |
| ------------------------------ | -------- | ---------------------------------------------------------------------------------------------------------------- |
| `drupal-unpublished-reachable` | high     | A node that is not published in Drupal and whose own page, `/node/NID`, answers a visitor with a page (probing). |

**`drupal-unpublished-reachable` is a probing check.** It reads content that is not public, with a credential, and then asks the site for the pages of that content as a visitor, so it is off unless you pass `--owner-consent` (or put the consent in `gaugeline.consent.json`) **and** the settings say `"readUnpublished": true`, and it should be run only on sites you own or have permission to test. Without both, Gaugeline asks nothing and the check says it was not asked; it is never a pass. It asks only about the types you name that are node types (a taxonomy term or a media item has no `/node/NID`; it is named as not checked), lists at most 100 unpublished nodes a type and asks for at most 100 pages a run, and reads each node as a node number and a status, nothing else. The page is asked on the Drupal address in `DRUPAL_URL` with no credential, no cookie and nothing the fetcher may add for a protected preview. A redirect is followed up to three times, and only within the same host. An answer counts only when Drupal itself sent it (an `X-Generator: Drupal` header or a Drupal generator meta tag) and when the final path is the node's path or its alias: a 403 from a firewall or a CDN, a login page, a front end's own route and a redirect elsewhere are could-not-check, never a pass. A 403 or 404 that is Drupal's own is a node closed to a visitor. A 2xx that is Drupal's own is looked at once more with the credential, by the node's id: only a node that is still unpublished is a finding, and a node that was published in between is could-not-check. If the credential lists no unpublished node, the check says so and does not pass: the role may not be allowed to view them, and that looks the same as having none. It sends no login, no form and no guess at a node number.

If your front end is separate from Drupal (a decoupled site), `/node/NID` is asked on the Drupal host in `DRUPAL_URL`, where Drupal serves it. The front end's own pages are not asked.

The check does not run from a command yet: like the other content checks it uses the adapter as it arrives (`readDrupal` and `createDrupalRegistry` in Gaugeline's core).

## What cannot be checked

Anything the platform does not expose is could-not-check, with the reason, never a pass and never scraped from Drupal's admin:

| Question                                                                     | Answer here                    | Why                                                                                                  |
| ---------------------------------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------- |
| Which resource types the site has                                            | only the ones you name         | Gaugeline does not ask Drupal for its types.                                                         |
| Whether a front end shows the same words as the CMS                          | not decided here               | The adapter gives hashes; the comparison with the page is the published-but-not-live check (F-05).   |
| A published node's page on the live site                                     | not asked                      | This adapter does not request published pages; the sitemap and feeds adapter and the page checks do. |
| Unpublished nodes in a translation, a revision or a content moderation state | not read                       | Only the node as the credential lists it, in the default language.                                   |
| Whether the whole published list was read, when it changes during the read   | caught in most cases           | Core JSON:API reports no total; see how a list is read.                                              |
| Fields that hold a reference (an image, a term)                              | not read                       | They are relationships in JSON:API, not attributes.                                                  |
| Who has access to Drupal (`members`)                                         | not offered                    | A credential is not asked for users or roles.                                                        |
| A site whose JSON:API path is not `/jsonapi`                                 | could not check                | The path is not configurable here.                                                                   |
| A type the credential cannot read                                            | could not check, for that type | The others are still read.                                                                           |

## When it cannot check

It never returns a list with a hole in it. The read is could-not-check, with the reason in plain words, when:

- `DRUPAL_URL` is not set, is not an address, has a user name, password, query or fragment in it, or is `http` while a credential is used (the credential is not sent over plain http);
- the credential is missing when unpublished nodes are asked for, both a token and a user name are set, a user name has no password, or a token, user name or password has a space (not allowed in a token), a line break or a character that is not plain ASCII, or a user name has a colon;
- Drupal does not show the published read to a visitor (HTTP 401 or 403), answers 404 (no such type, the JSON:API module is off, or its path was moved), answers a redirect, or does not accept the credential;
- a name under `urls` or `fingerprint` is not a JSON:API type name, a field is not a Drupal field name, or no type is named at all;
- an answer is not the shape JSON:API sends, a resource is not of the type asked for or has no usable id, a status is missing or not `true` or `false`, a resource has neither `changed` nor `created`, a type is bigger than the bound, or a page is too big even at 10 resources;
- the `next` link points to another host or path, or does not continue the list where it should;
- the same resource is listed twice, the count Drupal reports (when it reports one) changes or does not match what came back, or the first page is different when read again at the end;
- an unpublished node has no node number, or Drupal lists a published node under the unpublished filter;
- the credential lists no unpublished node (its role may not view them), a type is not a node type, or more than 100 unpublished nodes a type were listed;
- a node's page answers anything but Drupal's own 2xx, 403 or 404 (a firewall, a login, a 5xx, a timeout, a redirect elsewhere), or Drupal would not confirm that a node a visitor could open is unpublished, or it was published in between.

## What is bounded

| Limit                                 | Value |
| ------------------------------------- | ----- |
| Resources in one page of a list       | 50    |
| Resources read from one type          | 5,000 |
| Unpublished nodes listed for one type | 100   |
| Node pages asked for in one run       | 100   |

There are no flags to raise them. A node beyond the budget is could-not-check, named in the result, not skipped quietly.

## Settings

| `gaugeline.adapters.json` field | What it does                                                                                                                                                                       |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapters[].id`                 | `drupal`.                                                                                                                                                                          |
| `adapters[].fingerprint`        | Fields to hash, by JSON:API type. Up to 20 per type. Naming a type here also means it is read.                                                                                     |
| `adapters[].urls`               | Where a type's pages live when a node has no path alias: a path or an https address on the site. Only `{slug}` and `{id}` are filled in. Naming a type here also means it is read. |
| `adapters[].readUnpublished`    | Lets the probing check list unpublished nodes with the credential. It also needs `--owner-consent`.                                                                                |

| Environment variable | What it is                                                                |
| -------------------- | ------------------------------------------------------------------------- |
| `DRUPAL_URL`         | The Drupal address, such as `https://www.client.example`. Required.       |
| `DRUPAL_TOKEN`       | A bearer token of a view-only user. Optional; only for unpublished nodes. |
| `DRUPAL_USER`        | The user name for Basic authentication. Optional, with `DRUPAL_PASSWORD`. |
| `DRUPAL_PASSWORD`    | The password for Basic authentication. Optional, with `DRUPAL_USER`.      |

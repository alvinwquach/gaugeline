# HubSpot CMS: content checks for sites built on HubSpot CMS

What a HubSpot CMS site's CMS says is published, against what the live site shows. Gaugeline only reads: it sends `GET` requests to HubSpot's CMS APIs with a private app token, and `GET` requests for the live site's own public pages.

## What this adapter reads, and the narrowest key

**The key first.** HubSpot has no read-only key. The narrowest it offers is a **private app token** whose scopes you choose one by one, so Gaugeline's key kind for HubSpot CMS is `scoped`. Give the private app only what the adapter reads: the **content** scope (CMS site pages, landing pages and blog posts), the **hubdb** scope (HubDB tables and rows, only if you name a table in the settings) and the **forms** scope (only for the deleted-form check). HubSpot's scope names, and whether a read-only variant of each exists, could not be confirmed when this page was written (see the note on sources), so check the scope picker in your private app and choose the read access where HubSpot offers it. Tick no scope the list above does not name. Gaugeline sends no write, and that is the whole of the promise: this page does not say a token "cannot change anything" until HubSpot's own page for the scope says so.

A freelancer's client for this page: a pop-up bakery, a clinic or a coach with a site on HubSpot CMS. The example below is Brass Whisk Bakehouse, an invented pop-up bakery.

This page lists what the adapter reads, a worked example, what the three HubSpot checks find, what it could not check and why, and what Gaugeline will not do. See [Content systems](/docs/integrations/) for the interface every adapter shares.

**A note on sources.** Documentation checked on: 2026-11-11. HubSpot's developer documentation could not be reached when this page was written (the build session's network policy refused `developers.hubspot.com`), so every endpoint path, answer shape and scope below is from the build's knowledge of HubSpot's v3 CMS APIs and is `uncited`: each is pinned by Gaugeline's tests over invented answers, not confirmed against the live pages. Check them against the current pages before relying on a detail: [CMS pages API](https://developers.hubspot.com/docs/api/cms/pages) [docs], [blog posts API](https://developers.hubspot.com/docs/api/cms/blog-post) [docs], [HubDB API](https://developers.hubspot.com/docs/api/cms/hubdb) [docs], [forms API](https://developers.hubspot.com/docs/api/marketing/forms) [docs], [private apps](https://developers.hubspot.com/docs/api/private-apps) [docs].

## What it reads

Every request to HubSpot is a `GET` to `https://api.hubapi.com`, through the same fetcher as every other request. Nothing else is ever sent to it. The requests to the live site are `GET`s of pages anyone can open.

| Endpoint (all uncited)                  | Scope          | What for                                                                                                     |
| --------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------ |
| `GET /cms/v3/pages/site-pages`          | content        | Site pages: id, slug, state, live address, update time. The type `site-pages`.                               |
| `GET /cms/v3/pages/landing-pages`       | content        | Landing pages. The type `landing-pages`.                                                                     |
| `GET /cms/v3/blogs/posts`               | content        | Blog posts. The type `blog-posts`.                                                                           |
| `GET /cms/v3/hubdb/tables`              | hubdb          | The published HubDB tables: id and name. Each is a type, `hubdb.<table name>`.                               |
| `GET /cms/v3/hubdb/tables/{table}/rows` | hubdb          | The published rows of a table: id, path and the columns you name.                                            |
| `GET /account-info/v3/details`          | none confirmed | The portal the token belongs to, so a form of another portal is not judged. Only for the deleted-form check. |
| `GET /marketing/v3/forms/{formId}`      | forms          | Whether a form still exists, for each different form a page embeds. Only for the deleted-form check.         |

Lists are read with `limit` and the cursor HubSpot returns in `paging.next.after`, to the real end of the cursor: a server that answers fewer items than asked still gives the whole list, and one that gives a cursor Gaugeline cannot follow (not plain characters, or one it was already given), more items than the bound, or fewer items than its own total is could-not-check, never a shorter list. A page that is too big is asked again with half as many items, down to 10. A page counts as published only when its `state` is `PUBLISHED` and it is not archived. When HubSpot answers 429 with a short `Retry-After`, Gaugeline waits once and goes on; after that it keeps what it read and says the result is partial.

## Make the key

In HubSpot, open **Settings, Integrations, Private Apps**, create an app named `Gaugeline, read only`, and on its **Scopes** tab choose the access listed above and nothing else. Put the token in the environment where Gaugeline runs, never in a file you commit:

```text
HUBSPOT_CMS_TOKEN=<the private app token>
```

The token goes in an `Authorization` header and never in an address, it is sent only to `https://api.hubapi.com`, a redirect to another origin is followed without it, the live site's pages are asked with no token at all, and every message, finding and report has it blanked.

### What reaches your computer

HubSpot's list endpoints send each page or row with all of its fields, and no documented parameter to leave them out could be confirmed, so Gaugeline asks for none (no `properties`, no `include`, no archived pages). Field values are used for exactly three things: counting which items have a field, hashing the fields the settings name, and, for the HubDB comparison, looking for a named column's value in the words of its page. The adapter keeps no value past that, and nothing but the short hash or the column's name is printed, logged or put in a finding or report. With no `fingerprint` in the settings, nothing is hashed and no table is compared.

## Example: a pop-up bakery on HubSpot CMS

Brass Whisk Bakehouse is an invented pop-up bakery. A freelancer built its site on HubSpot CMS: a menu page, an about page, a landing page for holiday pre-orders, two blog posts, and a HubDB table of loaves with one dynamic page that shows a row for each loaf. The same HubSpot account also serves the bakery's wholesale site on a second domain. The baker edits in HubSpot between bakes. The freelancer wants to know which published pages are gone on the live domain, whether the price on a loaf's page is the one in the table, and whether a form was deleted while a page still shows it.

Settings go in `gaugeline.adapters.json` in the project folder. Nothing in it is a key. A table is named `hubdb.` and its name; its columns under `fingerprint` are the ones compared with the page.

```json title=gaugeline.adapters.json
{
  "adapters": [
    {
      "id": "hubspot-cms",
      "fingerprint": {
        "site-pages": ["name", "metaDescription"],
        "hubdb.loaves": ["name", "price"]
      }
    }
  ]
}
```

With `HUBSPOT_CMS_TOKEN` in the environment, this is what the adapter reads over the bakery's portal (invented: one site page is a draft, and the wholesale landing page is on the other domain):

```json title=Output
{
  "types": [
    {
      "name": "blog-posts",
      "count": 2
    },
    {
      "name": "hubdb.loaves",
      "count": 3
    },
    {
      "name": "landing-pages",
      "count": 2
    },
    {
      "name": "site-pages",
      "count": 3
    }
  ],
  "site page fields": {
    "name": 3,
    "metaDescription": 2,
    "subtitle": 0
  },
  "a list that does not exist": "HubSpot CMS has no list named products (site-pages, landing-pages, blog-posts and hubdb.<table> are the names).",
  "drafts reachable": true,
  "published site pages": [
    {
      "id": "101",
      "type": "site-pages",
      "url": "https://brass-whisk.example/menu",
      "slug": "menu",
      "publishedAt": "2026-09-01T09:00:00.000Z",
      "updatedAt": "2026-10-20T08:30:00.000Z",
      "fieldHashes": {
        "name": "2e04e30b9073e05c",
        "metaDescription": "c1544b1b6788f1e5"
      }
    },
    {
      "id": "102",
      "type": "site-pages",
      "url": "https://brass-whisk.example/about",
      "slug": "about",
      "publishedAt": "2026-09-02T09:00:00.000Z",
      "updatedAt": "2026-11-02T17:00:00.000Z",
      "fieldHashes": {
        "name": "c6ffd96077c4aa77"
      }
    },
    {
      "id": "103",
      "type": "site-pages",
      "url": "https://brass-whisk.example/bread",
      "slug": "bread",
      "publishedAt": "2026-09-03T09:00:00.000Z",
      "updatedAt": "2026-11-05T10:00:00.000Z",
      "fieldHashes": {
        "name": "78d73116c51a64d3",
        "metaDescription": "573a7ba288a71e64"
      }
    }
  ]
}
```

Read it the way the freelancer does. `site-pages` has three published pages, though HubSpot holds four: the fourth is a draft, and `drafts reachable` is `true` because the token can see it. `metaDescription` counts 2 because the about page has none, so it has no hash for it (a field a page lacks is left out, never hashed as empty), and `subtitle` counts 0 because no page has one. `landing-pages` counts 2, one of which belongs to the second domain. A list name HubSpot does not have is could-not-check, never zero. The hashes stand for the values without showing them: if the title changes, the hash changes.

The checks then run over the portal and the live site, after the baker raised the rye loaf's price in the live template but not in the table, a blog post was moved, and a form was deleted:

```json title=Findings
{
  "findings": [
    {
      "check": "hubspot-page-404",
      "severity": "high",
      "evidence": "blog-posts blog/new-oven is published in HubSpot and /blog/new-oven answers 404",
      "url": "https://brass-whisk.example/blog/new-oven"
    },
    {
      "check": "hubspot-form-deleted",
      "severity": "high",
      "evidence": "form 5c1d2e3f-0000-4000-8000-00000000d00d no longer exists in HubSpot and is embedded on /bread/rye",
      "url": "https://brass-whisk.example/bread/rye"
    },
    {
      "check": "hubspot-hubdb-drift",
      "severity": "medium",
      "evidence": "hubdb.loaves row 7002: column price is not on /bread/rye",
      "url": "https://brass-whisk.example/bread/rye"
    }
  ],
  "could not check": [],
  "passed": []
}
```

- **`hubspot-page-404`**: the blog post is published in HubSpot and its address answers 404 on the live domain. The wholesale landing page, which the portal serves on another domain, is not counted for this site and is not asked.
- **`hubspot-hubdb-drift`**: the price of row 7002 is not on its page. The finding names the column, never the price.
- **`hubspot-form-deleted`**: the rye page embeds a form HubSpot no longer has, so its enquiries go nowhere.

## The three checks

All three are in the [checks reference](/docs/checks) with what they catch, why it matters, how to fix it and a technical line. None is a probing check: every address they ask of the live site is a page anyone can open.

| Check                  | Severity | Finds                                                                                                    |
| ---------------------- | -------- | -------------------------------------------------------------------------------------------------------- |
| `hubspot-page-404`     | high     | A page HubSpot says is published, on this domain, whose own address answers 404 or 410 on the live site. |
| `hubspot-hubdb-drift`  | medium   | A published HubDB row whose value in a column you named is not on the dynamic page that shows the row.   |
| `hubspot-form-deleted` | high     | A form id embedded in a page that HubSpot says does not exist in the token's portal.                     |

The HubDB comparison looks for the value in the words of the page (scripts, styles and tags removed, entities decoded, case ignored). A number is looked for as written, with two decimals and with a thousands comma, as a whole number: `8` is found in `$8.00` and not in `$18.00`. A value the template formats another way (spelled out, in another currency) shows as differing: name another column, or read the finding as a prompt to look. A row with no path has no page of its own, and a table that no published dynamic page shows is could-not-check, by name.

Forms are read from the HTML as text (`data-form-id`, and `formId` and `portalId` in an `hbspt.forms.create` call): nothing in the page is run. A form is judged only when the page names exactly the portal the token belongs to.

The checks do not run from a command yet: like the other content checks they use the adapter as it arrives (`readHubspotCms` and `createHubspotCmsRegistry` in Gaugeline's core).

## What cannot be checked

Anything the platform does not expose is could-not-check, with the reason, never a pass and never scraped from HubSpot's admin screens:

| Question                                       | Answer here                    | Why                                                                                                              |
| ---------------------------------------------- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------- |
| Who has access to the portal (`members`)       | not offered                    | The adapter asks for no user list.                                                                               |
| Whether a page shows the same words as the CMS | not decided here               | The adapter gives hashes; the comparison with the page is the published-but-not-live check.                      |
| A page's address                               | from HubSpot's own `url`       | A page with no usable https address is could-not-check; a `urls` pattern in the settings wins when you give one. |
| HubDB rows that are only drafts                | not read                       | Only the published rows are asked for; the draft rows endpoint is not used.                                      |
| A HubDB table listed on a page, not per row    | could not check                | Only a published dynamic page for the table, with a path for each row, can be compared.                          |
| A part the token may not read                  | could not check, for that part | HTTP 403 for blog posts, HubDB or forms leaves the other parts read, and the result says which part was not.     |
| Other languages and translated variants        | read as separate pages         | HubSpot lists each variant as a page of its own; each is checked at its own address.                             |
| Content on another domain of the account       | not counted for this site      | Its pages are another site's: counted as `otherDomain`, not asked.                                               |
| Any HubSpot endpoint that needs `POST`         | could not check                | The adapter sends `GET` only. A read-only `POST` waits for ADR-0006 (see the open question in the pull request). |

## When it cannot check

It never returns a list with a hole in it. The read is could-not-check, with the reason in plain words, when:

- `HUBSPOT_CMS_TOKEN` is not set (nothing is asked), or HubSpot does not accept it (HTTP 401);
- the token may not read a part (HTTP 403: the private app needs the scope for it), which is could-not-check for that part only;
- a list name is not one of `site-pages`, `landing-pages`, `blog-posts` or `hubdb.<table>`, or the table named in the settings is not a published HubDB table;
- an answer is not the shape HubSpot sends, or an item has no usable id (letters, digits, dots, hyphens and underscores) or no update time;
- a list is bigger than the bound, a page of items is too big even at 10 items, the cursor repeats or is not plain, or the list stops before its total;
- a page answers anything but a page or a 404 or 410 (a 503, a login, a timeout), in which case that one page is could-not-check.

A platform that asks Gaugeline to slow down (HTTP 429) is waited for once when it says how long and the wait is a minute or less; after that the run keeps what it had read and says it is partial.

## What is bounded

| Limit                                  | Value  |
| -------------------------------------- | ------ |
| Items in one page of a list            | 100    |
| Items read from one list               | 10,000 |
| Live pages asked for in one run        | 300    |
| Different forms asked about in one run | 50     |
| Form embeds read from one page         | 20     |

There are no flags to raise them. A page beyond the budget is could-not-check, named in the result, not skipped quietly.

## Settings

| `gaugeline.adapters.json` field | What it does                                                                                                                                                                      |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapters[].id`                 | `hubspot-cms`.                                                                                                                                                                    |
| `adapters[].fingerprint`        | Fields to hash, by list (`site-pages`, `landing-pages`, `blog-posts`, `hubdb.<table>`). Up to 20 per list. A `hubdb.<table>` entry also names the columns compared with the page. |
| `adapters[].urls`               | Where a list's pages live: a path or an https address. Only `{slug}` and `{id}` are filled in. Without it HubSpot's own address is used.                                          |

| Environment variable | What it is                                                                                               |
| -------------------- | -------------------------------------------------------------------------------------------------------- |
| `HUBSPOT_CMS_TOKEN`  | A private app token with the content, hubdb and forms scopes the checks you want need, and nothing else. |

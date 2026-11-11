# Sitecore XM Cloud: content checks for sites built on Sitecore XM Cloud

What a Sitecore XM Cloud site says is published to Experience Edge, against what the live site shows. Gaugeline only reads, and the one key it asks for is the Delivery API token that the site's own front end already uses.

## What this adapter reads, and the narrowest key

**The key first.** Sitecore XM Cloud publishes content to Experience Edge, and a site reads it through the Delivery GraphQL API with a Delivery API token sent in an `sc_apikey` header. That token is the only key Gaugeline asks for, and it is read-only by nature: the Delivery API answers queries only, and only for content that was published to Edge, while changing content is a different API (the Authoring and management GraphQL API) that uses a different kind of credential. Sitecore's documentation describes both Edge GraphQL APIs for reading as read-only and says writing needs the Authoring and management API. The token is made in Sitecore Deploy, on the environment's Details tab, or with the Token REST API (scope `audience-delivery`). Gaugeline's key kind for Sitecore XM Cloud is `read-only`. Gaugeline never asks for an Authoring token, a Preview token or a sign-in.

The token comes from the environment, never from a file you commit:

```text
SITECORE_API_KEY=<the Delivery API token>
```

The token goes in the `sc_apikey` header and never in an address or a request body, it is sent only to `edge.sitecorecloud.io`, a redirect is never followed, and every message, finding and report has it blanked. A freelancer's client for this page: a yoga studio, a bar or a clinic with a brochure site on XM Cloud. The example below is Larkspur Yoga Studio, invented.

**A note on sources.** Sitecore's documentation pages could not be opened when this page was written (the build session's network policy refused `doc.sitecore.com`). Documentation checked on: 2026-11-11, which means the pages were not read: the endpoint, the header, the paging rules and the route query below are from search excerpts of Sitecore's documentation and from the source of Sitecore's own JavaScript SDK (`@sitecore-jss/sitecore-jss` 22.8.0, which sends exactly this query to list a site's pages), and are pinned by Gaugeline's tests over invented answers. They are not confirmed against the live pages, and the allowlist entry that lets Gaugeline send the query is marked as not verified for that reason. Check them against the current pages before relying on a detail: [Experience Edge APIs](https://doc.sitecore.com/sai/en/developers/sitecoreai/experience-edge/experience-edge-apis/experience-edge-apis.html) [docs], [authorization and API access](https://doc.sitecore.com/sai/en/developers/sitecoreai/experience-edge/experience-edge-apis/authorization-and-api-access.html) [docs], [the token API](https://doc.sitecore.com/sai/en/developers/sitecoreai/experience-edge/experience-edge-apis/token-rest-api.html) [docs], [limitations and restrictions of Experience Edge](https://doc.sitecore.com/sai/en/developers/sitecoreai/limitations-and-restrictions-of-experience-edge.html) [docs], [the Preview GraphQL endpoint](https://doc.sitecore.com/xmc/en/developers/xm-cloud/en/the-preview-graphql-endpoint.html) [docs].

This page lists what is read, how to make the token, a worked example, what the two Sitecore checks find, what could not be checked, and what Gaugeline will not do. See [Content systems](/docs/integrations/) for the interface every adapter shares.

## What it reads

The Delivery API answers a GraphQL query with a `POST`, because the query travels in the body. Gaugeline sends it under ADR-0006 (`docs/adr/0006-read-only-post-queries.md`): through one fetcher method that takes the id of an allowlist entry this adapter registered, refuses anything that is not exactly one GraphQL `query`, refuses any address but the entry's, and never follows a redirect. The request log records the address and the entry's id, never the body or the token.

| Request                                                                                      | Key                                   | What for                                                                                                                                                      |
| -------------------------------------------------------------------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST https://edge.sitecorecloud.io/api/graphql/v1` with the `site` and `routes` query below | the Delivery API token in `sc_apikey` | The published routes of your site, per language: counts and the route paths. `uncited` (see the note on sources)                                              |
| `GET {site}/sitecore/api/graph/edge`                                                         | none                                  | Only with `--owner-consent` and `expectPrivate: true`: whether the preview endpoint's path answers on the public site. See [the two checks](#the-two-checks). |
| one `GET` of each route's page on the live site                                              | none                                  | For the route-with-no-page check: the route path, or the language's `urls` prefix plus the route path.                                                        |

The query, in full. Every value is a GraphQL variable; none is written into the document, so a site name can never change what is asked. It selects the route path and nothing else:

```text
query Routes($site: String!, $language: String!, $pageSize: Int, $after: String) {
  site { siteInfo(site: $site) {
    routes(language: $language, first: $pageSize, after: $after) {
      total
      pageInfo { endCursor hasNext }
      results { routePath }
    }
  } }
}
```

Routes are read a page at a time (100 routes, where Experience Edge allows up to 1000) by following the `endCursor` it returns until `hasNext` is false. A list is complete only then: a page that says there is more and gives no cursor, a page that does not say whether there is more, a cursor that comes back twice or that is not a plain token, an empty page that is not the end, a route listed twice, fewer routes than `total`, more routes than were asked for, a language with more than 10,000 routes and a list that needs more requests than that many routes could need are all could-not-check, never a count of part of the list. A page that is too big is asked again with half as many routes, down to 10. When Experience Edge answers 429 (it allows about 80 requests a second) with a short `Retry-After`, Gaugeline waits once and goes on; after that it keeps what it read and says the result is partial.

The route path must be a plain path: one leading `/`, never a host (`//`), a scheme, `..`, a backslash, a control character or an escaped dot, slash or backslash. A route that is not is could-not-check for the whole list, because a list with a route Gaugeline cannot trust is not a list it can count.

### What reaches your computer

Nothing but route paths and counts. The query selects `routePath` and no field of any item, so no text of the client's pages is requested, kept, hashed, printed or put in a finding or report. A GraphQL error is reported as a count, never its message, because a message can quote content.

## Make the key

In Sitecore Deploy, open the project and the environment, and on the Details tab create a Delivery API token (it is the same token the site's front end uses as `SITECORE_API_KEY`). Or create one with the Token REST API with the scope `audience-delivery`. Put it in the environment where Gaugeline runs. Use a token for the environment the live site is built from, so that its published routes are the ones the site should show.

If the front end only has a Context ID (the unified `edge-platform.sitecorecloud.io` route), Gaugeline cannot use it: that route puts the Context ID in the address, and Gaugeline never sends a credential in an address. Create a Delivery API token instead.

## Example: a yoga studio on Sitecore XM Cloud

Larkspur Yoga Studio is an invented small studio. A freelancer built its site on Sitecore XM Cloud with a Next.js front end: classes (one page each), teachers (one page each) and a few notices, in English and in Canadian French (under `/fr-ca`). The owner publishes from her phone between classes. The freelancer wants to know, before the owner does, which published pages are not on the live site, and whether the preview endpoint can be reached from the public site.

Settings go in `gaugeline.adapters.json` in the project folder. Nothing in it is a key. `siteName` is the site's name in Sitecore's site configuration, `languages` are the languages to read (the first is the site's own, whose pages have the route path as their address), and `urls` gives the address prefix of any other language.

```json title=gaugeline.adapters.json
{
  "adapters": [
    {
      "id": "sitecore",
      "siteName": "larkspur",
      "languages": ["en", "fr-CA"],
      "urls": { "fr-CA": "/fr-ca" },
      "expectPrivate": true
    }
  ]
}
```

What the adapter reads over the invented site (the output is the real one, and a test compares it with the tool):

```json title=Output
{
  "types": [
    {
      "name": "en",
      "count": 6
    },
    {
      "name": "fr-CA",
      "count": 3
    }
  ],
  "published routes in fr-CA": [
    {
      "id": "fr-CA:/",
      "type": "fr-CA",
      "url": "/fr-ca/",
      "fieldHashes": {}
    },
    {
      "id": "fr-CA:/classes",
      "type": "fr-CA",
      "url": "/fr-ca/classes",
      "fieldHashes": {}
    },
    {
      "id": "fr-CA:/classes/morning-flow",
      "type": "fr-CA",
      "url": "/fr-ca/classes/morning-flow",
      "fieldHashes": {}
    }
  ],
  "field counts": "Not applicable to what Gaugeline reads from Experience Edge: the route list (the pages published to Edge) has no fields. Gaugeline compares routes with the live site's pages, and reads no field value.",
  "drafts reachable": "not-applicable"
}
```

There are 6 published routes in English and 3 in French. A route list has no dates and no fields, so `fieldCounts` says it is not applicable and no timestamp is made up. The Delivery API shows only what was published to Edge, so a draft (the retreat page, saved and not published) is not in the list at all, and `draftsReachable` is `not-applicable` rather than a measured no.

## The two checks

Both read from one pass over the site, not from a page, so they are listed in the [checks reference](/docs/checks) and are not part of a page run. Over the same site after the front end lost two pages, and with the owner's consent:

```json title=Findings
{
  "findings": [
    {
      "check": "sitecore-route-no-page",
      "severity": "high",
      "evidence": "en: /classes/evening-stretch is published to Experience Edge and answers 404 on the live site"
    },
    {
      "check": "sitecore-route-no-page",
      "severity": "high",
      "evidence": "fr-CA: /classes/morning-flow is published to Experience Edge and its page /fr-ca/classes/morning-flow answers 410 on the live site"
    },
    {
      "check": "sitecore-preview-public",
      "severity": "medium",
      "evidence": "a request with no key to /sitecore/api/graph/edge on the public site was answered by a GraphQL server (HTTP 200), and gaugeline.adapters.json says it should not be reachable there (expectPrivate)"
    }
  ],
  "no finding": [],
  "could not check": []
}
```

- `sitecore-route-no-page` (high): Experience Edge says a route is published, and its page answers 404 or 410 on the live site. Any other answer that is not a 2xx is could-not-check for that page, and a language with no `urls` prefix that is not the first is could-not-check by name, because its pages' addresses are not known and are not guessed. At most 300 pages are asked in one run; the rest are named could-not-check.
- `sitecore-preview-public` (medium, **probing**): the preview endpoint (`/sitecore/api/graph/edge`) reads draft content and is meant to be protected by its own key. The check asks that path once on the public site's own host, with no key, and reports it when a GraphQL server answers (HTTP 200 or 400). It is a probing check, so it is off unless you pass `--owner-consent` (or set it in `gaugeline.consent.json`) **and** the settings say `expectPrivate: true`. Run it only on sites you own or have permission to test. A 401 or 403 (a protected endpoint) and a 404 or 410 (a path that is not there) are no finding; a page that answers every path and any other status are could-not-check.

## What cannot be checked

Anything the platform does not expose is could-not-check, with the reason, never a pass and never scraped from Sitecore's admin screens:

| Question                                                      | Answer here             | Why                                                                                                                                                                                             |
| ------------------------------------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Whether a draft is reachable with the key (`draftsReachable`) | not applicable          | The Delivery API answers only for content published to Edge, by design. That is the documented behaviour, not something Gaugeline measured. The preview endpoint is the separate probing check. |
| Which fields an item has (`fieldCounts`)                      | not applicable          | The route list has no fields, and Gaugeline asks for none.                                                                                                                                      |
| When a route last changed                                     | not offered             | The route query gives no date, and none is made up.                                                                                                                                             |
| Who has access (`members`)                                    | not offered             | Experience Edge does not list members.                                                                                                                                                          |
| A language's pages with no `urls` prefix                      | could-not-check by name | Sitecore's route path is the same in every language; how the front end prefixes a language is not something Gaugeline can read.                                                                 |
| The preview endpoint on a separate content management host    | not asked               | The check asks the public site's own host only. A preview endpoint on another host is exactly what `expectPrivate` wants.                                                                       |

## When it cannot check

It never returns a list with a hole in it. The read is could-not-check, with the reason in plain words, when:

- `SITECORE_API_KEY` is not set or holds characters a token does not have (nothing is asked), or Experience Edge does not accept it (HTTP 401 or 403);
- there is no `siteName`, or Experience Edge has no site by that name for this token;
- a language, a site name or a `urls` prefix is not in the form Gaugeline sends (nothing is asked);
- an answer is not the shape the platform sends, carries GraphQL errors, or has a route with no usable path;
- a list is bigger than the bound, a page is too big even at 10 routes, or the list stops before its total or does not come to an end.

A platform that asks Gaugeline to slow down (HTTP 429) is waited for once when it says how long and the wait is a minute or less; after that the run keeps what it had read and says it is partial.

## What is bounded

| Limit                        | Value  |
| ---------------------------- | ------ |
| Routes in one page of a list | 100    |
| Routes read for one language | 10,000 |
| Languages in one run         | 5      |
| Live pages asked in one run  | 300    |

There are no flags to raise them.

## What Gaugeline will not do

- Send anything but a GraphQL `query` to the Delivery endpoint: no `mutation`, no `subscription`, no stored-query id, and no other method.
- Use the Authoring and management API, the Preview API with a key, a Context ID or a sign-in.
- Send the token anywhere but `edge.sitecorecloud.io`, or in an address or a body.
- Ask the preview endpoint without `--owner-consent` and `expectPrivate: true`.
- Read a page's text or a field of an item.

## Settings

| `gaugeline.adapters.json` field | What it does                                                                                                                                                                                                                                     |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `adapters[].id`                 | `sitecore`.                                                                                                                                                                                                                                      |
| `adapters[].siteName`           | The site's name in Sitecore's site configuration. Letters, digits, dots, hyphens and underscores, up to 64. Required.                                                                                                                            |
| `adapters[].languages`          | The languages to read, such as `["en", "fr-CA"]`. Default `["en"]`. Up to 5. The first is the site's own.                                                                                                                                        |
| `adapters[].urls`               | By language: the start of the address that language's pages have, a path such as `/fr-ca` or an https address such as `https://fr.studio.example`. The route path is added after it. For the first language the route path alone is the address. |
| `adapters[].expectPrivate`      | The preview endpoint should not answer on the public site. Switches on `sitecore-preview-public` (still only with `--owner-consent`).                                                                                                            |

| Environment variable | What it is                                                                              |
| -------------------- | --------------------------------------------------------------------------------------- |
| `SITECORE_API_KEY`   | The Delivery API token, sent as `sc_apikey` to `edge.sitecorecloud.io` only. Read-only. |

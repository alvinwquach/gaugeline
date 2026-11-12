# Ghost: content checks for sites built on Ghost

What a Ghost site says is published, read from the files every Ghost site already hands its visitors: its sitemap and its RSS feed. No key, no account, nothing to install on the client's side.

**The key first.** None. Gaugeline has no native Ghost adapter. Ghost's Content API is read with a Content API key, and the vendor's own package sends that key in the address (the `key` query parameter), never in a header. Gaugeline sends a key only in a header and never writes one into an address, a log, a finding or a report, so it does not read the Content API at all (open question 53, the same decision as Storyblok and Builder.io). A Ghost site is read through the [sitemap and feeds adapter](/docs/integrations/sitemap-feed), which sends no `Authorization` header and no cookie and never logs in. A run says so before anything else it prints about the content system:

```text title=Header
Content system: Sitemap and feeds, with no key (it only reads pages the site already publishes). How it reads them: https://gaugeline.dev/docs/integrations/sitemap-feed
```

See [Content systems](/docs/integrations/) for the interface every adapter shares.

## What was checked, and what is uncited

- **The key goes in the address.** Checked 12 Nov 2026 against the vendor's package `@tryghost/content-api` (npm, version 1.12.13, MIT licence), not against the vendor's documentation: the documentation site could not be reached from the build machine, and Gaugeline's documentation source was not connected. The package builds each request as a `GET` to `<site>/ghost/api/content/<resource>/` with the key added to the query parameters (`key`). The only header it sets for authorisation is `Authorization: GhostMembers`, which carries a members token, not the Content API key. So no header spelling for the key is known.
- **The file names a Ghost site publishes are uncited.** That a Ghost site publishes `/sitemap.xml` with children such as `sitemap-posts.xml`, `sitemap-pages.xml` and `sitemap-tags.xml`, an RSS feed at `/rss/`, and a `robots.txt` that names the sitemap is written from memory and could not be confirmed against Ghost's documentation. The adapter does not depend on those names: it follows whatever `robots.txt` and the home page advertise, then tries the usual paths. Check a real site before relying on a detail.
- **The recipe is kept.** The [Ghost recipe](/docs/integrations/recipes/#ghost) for the generic API adapter stays in the repository with its recorded answers, marked `blocked`, so a run asks for nothing and says why. If the owner decides that a key may sit in an address, or Ghost adds a header spelling, the recipe is the first thing to turn on.

## What it reads

Every request is a `GET`, to the checked site and nowhere else, through the same fetcher as every other request, which refuses private, loopback, link-local and metadata addresses.

- `GET /robots.txt`, for its `Sitemap:` lines.
- The sitemaps named there, and a sitemap index's children.
- The feeds the home page advertises, or `/rss/` and the usual feed paths when it advertises none.

From each file only an address and its dates are kept. A title, a description or a word of a post never is, so none can reach a report. The [sitemap and feeds page](/docs/integrations/sitemap-feed) has the limits, the dates and the safety rules, which are the same here.

## Example: a coffee roaster's journal and members newsletter

Lowtide Roasters is an invented small-batch coffee roaster. A freelancer runs its journal and a paid members newsletter on Ghost. The owner publishes from the admin screen, tags the members-only posts with a `Members` tag, and the freelancer wants to know which pages changed this month without being handed an admin login.

Settings go in `gaugeline.adapters.json` in the project folder. The `site` line is only needed when the run is not given the address:

```json title=gaugeline.adapters.json
{
  "adapters": [
    {
      "id": "sitemap-feed",
      "site": "https://lowtide-roasters.example"
    }
  ]
}
```

Lowtide's `robots.txt` names a sitemap index with three children (posts, pages, tags) and its home page advertises one RSS feed. This is what the adapter reads over it (invented), for pages changed since 1 November:

```json title=Output
{
  "types": [
    {
      "name": "members",
      "count": 1
    },
    {
      "name": "roasting",
      "count": 1
    },
    {
      "name": "tag",
      "count": 2
    },
    {
      "name": "top-level",
      "count": 4
    }
  ],
  "field counts": "could not check: Not applicable: a sitemap or a feed lists addresses and dates, not fields, so there is nothing to count. Field counts need a native adapter for the content system.",
  "drafts reachable": "not-applicable",
  "changed since 1 November": [
    {
      "id": "https://lowtide-roasters.example/harbour-blend-tuesday/",
      "type": "roasting",
      "url": "https://lowtide-roasters.example/harbour-blend-tuesday/",
      "slug": "harbour-blend-tuesday",
      "publishedAt": "2026-11-03T08:00:00.000Z",
      "updatedAt": "2026-11-04T00:00:00.000Z",
      "fieldHashes": {}
    },
    {
      "id": "https://lowtide-roasters.example/green-coffee-prices/",
      "type": "members",
      "url": "https://lowtide-roasters.example/green-coffee-prices/",
      "slug": "green-coffee-prices",
      "publishedAt": "2026-11-05T08:00:00.000Z",
      "updatedAt": "2026-11-05T00:00:00.000Z",
      "fieldHashes": {}
    },
    {
      "id": "https://lowtide-roasters.example/autumn-opening-hours/",
      "type": "top-level",
      "url": "https://lowtide-roasters.example/autumn-opening-hours/",
      "slug": "autumn-opening-hours",
      "publishedAt": "2026-11-06T07:00:00.000Z",
      "updatedAt": "2026-11-06T00:00:00.000Z",
      "fieldHashes": {}
    },
    {
      "id": "https://lowtide-roasters.example/",
      "type": "top-level",
      "url": "https://lowtide-roasters.example/",
      "updatedAt": "2026-11-06T00:00:00.000Z",
      "fieldHashes": {}
    },
    {
      "id": "https://lowtide-roasters.example/tag/roasting/",
      "type": "tag",
      "url": "https://lowtide-roasters.example/tag/roasting/",
      "slug": "roasting",
      "updatedAt": "2026-11-04T00:00:00.000Z",
      "fieldHashes": {}
    },
    {
      "id": "https://lowtide-roasters.example/tag/members/",
      "type": "tag",
      "url": "https://lowtide-roasters.example/tag/members/",
      "slug": "members",
      "updatedAt": "2026-11-05T00:00:00.000Z",
      "fieldHashes": {}
    }
  ]
}
```

Read it the way the freelancer does:

- Ghost puts a post at the top level of the address (`/autumn-opening-hours/`), so a sitemap gives it no folder to group by. A post in the feed with a tag is grouped by its first tag (`roasting`, `members`); a post with no tag is `top-level`. Tag pages sit under `/tag/` and group as `tag`. The groups are only as good as the site's tagging.
- The members post is listed with its address and dates, like any other. That is all a sitemap and a feed can say about it: whether its full text is open to visitors is not visible here (see below).
- The old summer post (a `lastmod` of 20 July) is left out because its date is older than 1 November.

Nothing of a post's title or text is in the output, though the feed carries them.

## What cannot run, and why

The content checks that compare a content system with the live page need the content system's side. Without the Content API, these parts are could-not-check with the reason, never a pass:

| Question                                                      | Answer here                            | Why                                                                                                                                                                                                    |
| ------------------------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Members-only posts whose full text appears in the public page | not checked                            | Which posts are members-only is a field of the Content API (the post's visibility). A feed and a sitemap do not say. Reading it needs the Content API key, which Gaugeline will not put in an address. |
| How many items have each field (`fieldCounts`)                | could not check, "Not applicable"      | There are no fields in a sitemap or a feed.                                                                                                                                                            |
| A hash of a field's value (`fieldHashes`)                     | always empty                           | There is nothing to hash. The settings' `fingerprint` is refused for this adapter.                                                                                                                     |
| Are drafts reachable (`draftsReachable`)                      | `not-applicable`, with no request made | A sitemap never lists a draft, so it cannot say whether Ghost has any.                                                                                                                                 |
| Who has access (`members`)                                    | not offered                            | No public file lists people. Gaugeline never reads Ghost's admin.                                                                                                                                      |

Whatever the Ghost documentation says, the rule that holds: Gaugeline sends `GET` and `HEAD` and nothing else, never reads the admin screen, and sends no key it cannot put in a header.

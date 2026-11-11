# Content systems: one interface for every CMS

What a client's content system says is published, against what the page shows.

Most of Gaugeline reads the live page the way a visitor does. A content system adds the other half: what the CMS says exists, when it changed, and whether the page matches. Each CMS is one adapter behind one interface, so a check written once works on every adapter that exists.

Sanity, [Sitemap and feeds](/docs/integrations/sitemap-feed), [WordPress](wordpress.md) and [Webflow](/docs/integrations/webflow) are built today. Sitemap and feeds needs no key and works for a site on any CMS that publishes a sitemap or a feed, so it is the default when no other adapter is configured. Every other row below is planned, with the branch that builds it. Nothing marked planned works yet, and asking for it is an error, not a silent skip.

## What is built and what is planned

| Content system                                       | Status         | Key Gaugeline asks for                                                                                                     | What it reads                                                                                                                                                                                                                                                                                           |
| ---------------------------------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sanity                                               | built          | read-only (a token with the Viewer role)                                                                                   | Type names and counts, how many items have each field, published items as fingerprints, whether drafts are reachable, who has access                                                                                                                                                                    |
| Sitemap and feeds                                    | built          | read-only (no key at all: it reads the files the site already publishes)                                                   | Published items from `sitemap.xml` (and indexes, gzip), RSS, Atom and JSON Feed, with their dates. [Which checks need a native adapter instead](/docs/integrations/sitemap-feed#what-needs-a-native-adapter-instead)                                                                                    |
| WordPress                                            | built          | scoped (an application password on a dedicated low-role user, for drafts and members only; published content needs no key) | Published posts, pages and custom types through the REST API: type names and counts, how many items have each field, published items as fingerprints, whether drafts are reachable, who has access; and two checks, `wp-outdated` and `wp-users-exposed`, with `--wordpress`. [WordPress](wordpress.md) |
| Webflow                                              | built          | read-only (a site token with only the `sites:read` and `cms:read` scopes)                                                  | Collections and their published items as fingerprints, field counts, whether staged or draft items exist, and items staged but not published. [Endpoints and the token](/docs/integrations/webflow)                                                                                                     |
| Framer                                               | planned (C-06) | set when built                                                                                                             | CMS collections (the platform's API is in beta)                                                                                                                                                                                                                                                         |
| Wix                                                  | planned (C-05) | set when built                                                                                                             | CMS collection items                                                                                                                                                                                                                                                                                    |
| Any headless CMS with a read API                     | planned (C-14) | set by the recipe                                                                                                          | A small mapping in settings, with recipes for Storyblok, Payload, Ghost, Drupal and others                                                                                                                                                                                                              |
| Content kept in git                                  | planned (C-15) | none                                                                                                                       | Markdown, MDX, JSON and YAML content in the repository                                                                                                                                                                                                                                                  |
| Squarespace and other builders without a content API | planned (C-12) | none                                                                                                                       | The live site only; the page says plainly which content checks cannot run                                                                                                                                                                                                                               |
| Strapi                                               | planned (C-02) | set when built                                                                                                             | Entries through the REST or GraphQL API                                                                                                                                                                                                                                                                 |
| TinaCMS                                              | planned (C-03) | set when built                                                                                                             | Content files in git, and TinaCloud when configured                                                                                                                                                                                                                                                     |
| Contentful                                           | planned (C-07) | set when built                                                                                                             | Entries through the Content Delivery API                                                                                                                                                                                                                                                                |

"Set when built" means the branch confirms the narrowest key against the platform's own documentation and writes it here first. Until then this page does not promise one. Storyblok, Payload, Ghost and Drupal ship first as recipes for the generic adapter (C-14); a native adapter is built for any of them when someone asks.

## The key, and what it can do

Every adapter says what kind of key it asks for, and a run prints it before anything else it says about the content system:

```text title=Output
Content system: Sanity, with a read-only key. Endpoints and how to make the key: https://gaugeline.dev/docs/private-datasets
```

| Key kind      | Meaning                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| `read-only`   | The platform can make a key that only reads (a Viewer token, a delivery token, a public API).                  |
| `scoped`      | The key is limited to what Gaugeline needs, but the platform cannot make it read-only.                         |
| `full-access` | The platform has nothing narrower. Gaugeline only reads with it, but the key could do more in someone's hands. |

An adapter that needs no key at all (Sitemap and feeds reads only what the site shows every visitor) says "with no key" in that line and sends no `Authorization` header and no cookie; its key kind is `read-only` because nothing it does can change anything. An adapter whose platform has no read-only key says so in the first paragraph of its own page and recommends the narrowest option, such as a dedicated low-role user. Keys come from environment variables, travel in a request header and never in an address, and are blanked from every message, finding and report.

## What an adapter reads, and what it never does

An adapter returns counts and fingerprints, never the client's text:

- **Types** and how many published items each has.
- **Field counts**: how many items of a type have a field. A field no item has counts 0, never an error.
- **Published items**: id, type, slug, address, published and updated times, and a short hash of each field you name. A field's value is read only to be hashed, and is not kept. With no fields named, no field value is requested at all.
- **Drafts reachable**: whether the key can see unpublished work. It asks for a count, never for a draft.
- **Members**, where the platform lists them and the key may read them: a masked address and a role ("r***@client.example", admin). The [handoff report](/docs/guides/handoff) reads the same list through its own reader, with more detail, and is unchanged.

Reports show field names and the mismatch, never the client's words. Anything an adapter reads is only ever read with GET or HEAD (or, where the platform answers a read only to a POST, a documented read-only query on the adapter's allowlist: a GraphQL query, never a mutation, or a JSON query with the vendor's documented keys; see ADR-0006), through the same fetcher as every other request, which refuses private and metadata addresses. Anything the platform does not expose is reported as could not check with the reason; nothing is ever scraped from an admin screen.

A platform that asks Gaugeline to slow down (HTTP 429) is waited for once when it says how long and the wait is a minute or less. If it still refuses, the run keeps what it had read and says it is partial: "Read 2 items, then the platform asked Gaugeline to slow down. Try again in 120 seconds. The rest was not read, so what is listed is not everything."

## Example: a coach on Sanity

Fernhill Coaching is an invented solo coach whose site a freelancer built with Next.js on Vercel, with Sanity behind it. She publishes blog posts, lists her packages and shows testimonials. The freelancer wants to know, before the client does, which posts changed lately and whether the page still says what the CMS says.

Settings go in `gaugeline.adapters.json` in the project folder. Nothing in it is a key:

```json title=gaugeline.adapters.json
{
  "adapters": [
    {
      "id": "sanity",
      "fingerprint": { "post": ["title", "summary"] },
      "urls": { "post": "/blog/{slug}" }
    }
  ]
}
```

With `SANITY_PROJECT_ID` and a Viewer token in the environment, this is what the adapter reads over her dataset (invented, with two unpublished drafts) for posts changed since 1 October:

```json title=Output
{
  "types": [
    {
      "name": "package",
      "count": 2
    },
    {
      "name": "post",
      "count": 3
    },
    {
      "name": "testimonial",
      "count": 2
    }
  ],
  "post fields": {
    "title": 3,
    "summary": 2,
    "subtitle": 0
  },
  "drafts reachable": true,
  "changed": [
    {
      "id": "post-spring",
      "type": "post",
      "url": "/blog/spring-cohort",
      "slug": "spring-cohort",
      "publishedAt": "2026-11-01T08:00:00.000Z",
      "updatedAt": "2026-11-03T14:30:00.000Z",
      "fieldHashes": {
        "title": "cce851737d5f32ef"
      }
    },
    {
      "id": "post-welcome",
      "type": "post",
      "url": "/blog/finding-your-next-step",
      "slug": "finding-your-next-step",
      "publishedAt": "2026-09-01T08:00:00.000Z",
      "updatedAt": "2026-10-20T09:00:00.000Z",
      "fieldHashes": {
        "title": "dde05df645f2d5a4",
        "summary": "127de2a66ab6242e"
      }
    }
  ]
}
```

Read it the way the freelancer does. The "Spring cohort" post has no `summary`, so it has no hash for it (a field an item lacks is left out, never hashed as empty), and `subtitle` is on no post (0). Two drafts are visible to this token and none of their text appears. The check planned as F-05 (published but not live) will compare each hash with the same field on the live page: a post whose hash no longer matches its page is one the client published and the site did not show. That check is not built yet; today the adapter gives it the fingerprints. The title and summary themselves are not in the output.

| `gaugeline.adapters.json` field | What it does                                                                                                                                                      |
| ------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `adapters[].id`                 | Which adapter. `sanity`, `sitemap-feed`, `wordpress` and `webflow` are built; a planned id is exit 2 and names its branch.                                        |
| `adapters[].fingerprint`        | Fields to hash, by type, as names or names joined by dots (`slug.current`). Up to 20 per type.                                                                    |
| `adapters[].urls`               | Where an item lives, by type: a path or an https address. Only `{slug}` and `{id}` are filled in; an item with no slug gets no address rather than a made-up one. |

`site`, `sitemaps` and `feeds` belong to `sitemap-feed` and are described on [its page](/docs/integrations/sitemap-feed#settings); `fingerprint` and `urls` are refused for it, because a sitemap has no fields.

Today `gaugeline query` reads the file: an unknown or planned adapter stops the run before anything is asked. The checks that compare the CMS with the page will use it as they arrive, and `gaugeline init` will write the entry from what the site shows once it exists.

## Sanity: the endpoints and the key

The Sanity adapter uses these read endpoints and nothing else:

- `GET https://<project>.api.sanity.io/v2021-10-21/data/query/<dataset>?query=...&perspective=published` for type names, counts and published items (GROQ queries are reads). `perspective=raw` is used only to count drafts.
- `GET https://api.sanity.io/v2021-06-07/projects/<project>` and `.../users/<ids>` for who has access, only when you ask for members (the handoff report).

The narrowest key is a token with the Viewer role; a public dataset needs none. [Private datasets](/docs/private-datasets) says how to make one. These endpoints and the versions are the ones Gaugeline already used for the query check and the handoff report: Sanity's own reference pages could not be reached when this was written, so check them against the current [HTTP reference](https://www.sanity.io/docs) before relying on a detail.

## Writing an adapter

Adding a content system means one adapter, one entry in the contract tests and one row in the table above. The steps are in [CONTRIBUTING.md](https://github.com/alvinwquach/gaugeline/blob/main/CONTRIBUTING.md#writing-an-adapter). The contract tests enforce, for every adapter: counts and fingerprints but never a field value; a missing field counts 0 (or, for a platform with no fields, field counts are could-not-check and every field hash is empty); no request but GET or HEAD is ever built; an adapter with no key sends no key header; a rate limit is waited out once and then reported as partial; and the key kind is shown in the run header and on this page.

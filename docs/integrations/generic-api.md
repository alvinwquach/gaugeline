# Generic API adapter: any headless CMS with a read API

One adapter reads a headless CMS that has a REST or GraphQL read API, from a small mapping in `gaugeline.adapters.json`: the endpoint, the header the key goes in (the key itself is an environment variable), how the list pages, and where the id, type, slug or address, update time and fingerprint fields are. It only reads: every request is a GET, and a GraphQL query is a GET with the document in the address. The key kind is `scoped`: the narrowest key is whatever the platform offers, and each [recipe](/docs/integrations/recipes/) says which. [docs]

Recipes for Storyblok, Payload, Ghost, Drupal JSON:API, Directus, Prismic, Hygraph, DatoCMS, Builder.io, Kontent.ai and Joomla are in [Recipes](/docs/integrations/recipes/). Where a platform later gets a native adapter, the recipe stays as the fallback and the native adapter must pass the recipe's recorded-response test.

## Example: a yoga studio's three sources

Heron Yoga Studio is an invented studio whose freelancer built a Next.js site on Vercel that reads posts from a Payload-style list, classes from a Directus-style list and workshops from a GraphQL connection. One entry reads all three. Nothing in it is a key: the key is the value of `GAUGELINE_API_HERON_TOKEN`, sent as `Authorization: Bearer <value>`.

```json title=gaugeline.adapters.json
{
  "adapters": [
    {
      "id": "generic-api",
      "fingerprint": {
        "post": ["title", "summary"]
      },
      "urls": {
        "post": "/blog/{slug}",
        "class": "/classes/{slug}"
      },
      "api": {
        "endpoint": "https://cms.heron-yoga.example",
        "auth": {
          "header": "Authorization",
          "env": "GAUGELINE_API_HERON_TOKEN",
          "prefix": "Bearer "
        },
        "collections": {
          "post": {
            "path": "/api/posts",
            "query": {
              "depth": "0"
            },
            "items": "/docs",
            "total": "/totalDocs",
            "pagination": {
              "style": "page",
              "page": "page",
              "size": "limit",
              "pageSize": 2,
              "more": "/hasNextPage"
            },
            "fields": {
              "id": "/id",
              "slug": "/slug",
              "updatedAt": "/updatedAt",
              "publishedAt": "/createdAt"
            }
          },
          "class": {
            "path": "/items/classes",
            "query": {
              "meta": "filter_count",
              "sort": "id",
              "filter[status][_eq]": "published"
            },
            "items": "/data",
            "total": "/meta/filter_count",
            "pagination": {
              "style": "offset",
              "limit": "limit",
              "offset": "offset",
              "pageSize": 2
            },
            "select": {
              "param": "fields",
              "always": ["id", "slug", "date_updated", "date_created"]
            },
            "fields": {
              "id": "/id",
              "slug": "/slug",
              "updatedAt": ["/date_updated", "/date_created"],
              "publishedAt": "/date_created"
            }
          },
          "workshop": {
            "graphql": "query Workshops($first: Int!, $after: String) { workshopsConnection(first: $first, after: $after, orderBy: id_ASC, stage: PUBLISHED) { edges { node { id slug updatedAt __FIELDS__ } } pageInfo { endCursor hasNextPage } } }",
            "items": "/data/workshopsConnection/edges",
            "fieldRoot": "/node",
            "pagination": {
              "style": "cursor",
              "cursor": "after",
              "size": "first",
              "pageSize": 2,
              "next": "/data/workshopsConnection/pageInfo/endCursor",
              "more": "/data/workshopsConnection/pageInfo/hasNextPage"
            },
            "fields": {
              "id": "/node/id",
              "slug": "/node/slug",
              "updatedAt": "/node/updatedAt"
            }
          }
        },
        "drafts": {
          "collection": "class",
          "query": {
            "filter[status][_eq]": "draft"
          }
        }
      }
    }
  ]
}
```

With the variable set, this is what the adapter reads (invented content; the drafts count is one unpublished class):

```json title=Output
{
  "types": [
    {
      "name": "class",
      "count": 3
    },
    {
      "name": "post",
      "count": 5
    },
    {
      "name": "workshop",
      "count": 3
    }
  ],
  "drafts reachable": true,
  "changed posts": [
    {
      "id": "p-1",
      "type": "post",
      "url": "/blog/beginner-flow",
      "slug": "beginner-flow",
      "publishedAt": "2026-10-01T08:00:00.000Z",
      "updatedAt": "2026-11-04T09:00:00.000Z",
      "fieldHashes": {
        "title": "61184a8a7c977954",
        "summary": "0ad5390a41d38ade"
      }
    },
    {
      "id": "p-2",
      "type": "post",
      "url": "/blog/solstice-closure",
      "slug": "solstice-closure",
      "publishedAt": "2026-10-05T08:00:00.000Z",
      "updatedAt": "2026-11-02T12:30:00.000Z",
      "fieldHashes": {
        "title": "184f3a97b8ff616d",
        "summary": "10ab7165ee0614ee"
      }
    }
  ]
}
```

Read it as the freelancer does. `class` has 3 published items and `workshop` 3; `post` has 5. The first two posts changed lately, and each has a short hash of its `title` and `summary`; the text is not in the output. A later check compares a hash with the same field on the live page. The GraphQL workshops are read with GET, 2 at a time, with the cursor of each page in the next request.

## The mapping

| `api` field   | What it does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`    | An https address with no key, query or fragment. `http://127.0.0.1` is accepted only with no key, for tests with `--allow-private`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `auth`        | `header` (such as `Authorization`, `X-API-Key`), `env` (a variable named `GAUGELINE_API_<NAME>`) and an optional `prefix` (`Bearer `). The variable must be named `GAUGELINE_API_<NAME>` (such as `GAUGELINE_API_DIRECTUS_TOKEN`): Gaugeline's own variables (`GAUGELINE_SLACK_WEBHOOK`, `GAUGELINE_GITHUB_TOKEN`, `GAUGELINE_VERCEL_TOKEN`, `GAUGELINE_BASIC_AUTH`, `GAUGELINE_POSTGRES_URL`...) are never accepted, so a mapping copied from the internet cannot send one of them to its server. The key is sent in that header to the endpoint's origin only, and is dropped on a redirect to another origin or to http. |
| `collections` | Up to 20, each a REST `path` or a `graphql` query, `items` (where the list is), `total` (where the count is), `pagination`, `fields` (`id` and `updatedAt` paths, optionally `type`, `slug`, `url`, `publishedAt`), `fieldRoot`, `published`, `select`.                                                                                                                                                                                                                                                                                                                                                                     |
| `pagination`  | `offset` (limit and offset parameters), `page` (page number and size), `cursor` (a cursor taken from the answer) or `none`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `maxPages`    | Pages read from one collection; default 50, at most 200. More pages than that is could-not-check, never a silent cut.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `bootstrap`   | A value the platform gives once and wants on every request (Prismic's `ref`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `drafts`      | A collection and parameters to ask whether the key can see unpublished work. Without it the answer is not-applicable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `blocked`     | `key-in-address`: the platform reads its key from the address. The mapping asks for nothing and says why.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Paths are pointers such as `/data/items` or `/attributes/changed`: letters, digits and `_ - . : @`, at most 8 segments and 200 characters, never `__proto__`, `constructor` or `prototype`. A collection path with a write verb in a part of it (`delete`, `update`, `create`, `publish`, `unpublish`, `send`, `archive`...), a parameter named like a method override (`method`, `_method`, `x-http-method-override`) or holding an HTTP or write verb as its value, a header such as `Range`, `Cookie`, `Host`, `Proxy-Authorization` or `X-Forwarded-*`, and a name that looks like a key (`token`, `jwt`, `bearer`, `pat`, `privateKey`...) anywhere in an address are refused. An endpoint with a dot segment (`..`, `%2e%2e`) or an encoded slash is refused. A GraphQL collection cannot be the `drafts` collection, and `bootstrap` cannot be used when a collection is GraphQL. Several can be given for a field and the first with a value is used. Page size is at most 200 and a collection at most 200 pages. The mapping is checked in full when the file is read: a path that is not a pointer, an endpoint that is not https, a key-like parameter, a variable not named `GAUGELINE_API_<NAME>`, a GraphQL mutation or a type that is not in `collections` is exit 2 with the file and the place named.

## What it never does

- It sends only GET. A GraphQL query goes in the address (`query` and `variables`), as the Sanity reader does. A GraphQL endpoint that answers a GET with 405 (POST only) is could-not-check: "the platform only answers GraphQL queries over POST". POST for documented read-only queries is decided (ADR-0006) and arrives as the follow-up branch C-14b; until it has merged, no POST is sent.
- It never writes a key into an address, a log, an error, a finding or a report. The variable's value is blanked from every message.
- It never follows a link the platform returns: every address is built from the endpoint.
- It does not put the client's text in a finding. An id, a slug and a type from an answer must be plain identifiers (letters, digits and `. _ ~ : @ -`, at most 128 characters, no whitespace), and an address must be a path with one leading slash (never `//host` or `/\host`); otherwise the read is could-not-check without quoting the value, because the mapping probably points at the wrong field. A page has at most 1,000 items and a cursor at most 500 characters.
- With a `published` guard, an item is published only when the value at its path is exactly the value configured (same kind, same case); a path that matches no item on a page is could-not-check, not an empty list.
- It reads a field's value only to hash or count it. With no `fingerprint` fields, a REST `select` asks for the fixed fields only and a GraphQL document gets nothing in place of `__FIELDS__`.
- A platform that wants its key in the address (Storyblok, Ghost, Builder.io) is not supported yet (open question 53).

Anything the mapping cannot answer is could-not-check with the reason: a list not found at `items`, an item with no id or update time, a refused key (naming the variable, never the key), a platform that repeats a page.

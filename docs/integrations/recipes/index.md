# Recipes for the generic API adapter

A recipe is a mapping for the [generic API adapter](/docs/integrations/generic-api): a JSON file in `docs/integrations/recipes/` and one file of recorded answers beside it. Copy the `settings` entry into `gaugeline.adapters.json`, set the environment variable it names, and change the paths to match your own content model.

Every recipe was written from memory of each vendor's documented API, because the vendors' own pages could not be reached when this was written. Each endpoint shape, field name and answer shape below is **uncited** except for the page linked as [docs]; the recorded answers are invented, not recorded from a live service. Check a recipe against the vendor's page before relying on it, and say what you find.

## How a recipe is tested

`<id>.json` is `{ "format": 1, "recipe", "name", "settings" }`. `<id>.recorded.json` is `{ "format": 1, "recipe", "provenance", "env", "exchanges", "expect" }`: each exchange is a request (`url`, the `query` parameters that must match, optional `headers`, with `{env:NAME}` standing for a variable) and the response; `expect` holds what the adapter must give for them (`types`, `fieldCounts`, `published`, `draftsReachable`). The test (`generic-api-recipes.test.ts`, with the format described in `recipe-harness.ts`) replays the answers through the fetcher and requires every exchange to be used, only GET requests, and no key in an address. The format is stable on purpose: the native adapters for these platforms must pass the same `expect` over the same answers, and the recipe stays as the fallback. A recipe with a wrong path fails validation before anything is asked (exit 2).

To add a recipe: add the two files, a section here, and nothing else.

## Payload

Docs: [Payload](https://payloadcms.com/docs/rest-api/overview) [docs].

- **Narrowest key:** An API key on a user of an `api-keys` enabled collection, whose access rules allow only `read` on the collections in the mapping. Scoped: Payload has no read-only key type, so the narrowest key is a dedicated user with read access only.
- **What it reads:** `GET /api/<collection>?page=&limit=&depth=0`; the answer is `docs`, `totalDocs`, `hasNextPage`. The key goes in `Authorization: users API-Key <key>`.
- **Example:** Heron-style studio sites built with Payload and Next.js on Vercel: the mapping lists `posts` and fingerprints `title` and `summary`.

```json title=payload.json
{
  "format": 1,
  "recipe": "payload",
  "name": "Payload",
  "settings": {
    "id": "generic-api",
    "fingerprint": {
      "post": ["title", "summary"]
    },
    "urls": {
      "post": "/blog/{slug}"
    },
    "api": {
      "endpoint": "https://studio.example/api",
      "auth": {
        "header": "Authorization",
        "env": "GAUGELINE_PAYLOAD_API_KEY",
        "prefix": "users API-Key "
      },
      "collections": {
        "post": {
          "path": "/posts",
          "query": {
            "depth": "0"
          },
          "items": "/docs",
          "total": "/totalDocs",
          "pagination": {
            "style": "page",
            "page": "page",
            "size": "limit",
            "pageSize": 100,
            "more": "/hasNextPage"
          },
          "fields": {
            "id": "/id",
            "slug": "/slug",
            "updatedAt": "/updatedAt",
            "publishedAt": "/createdAt"
          }
        }
      }
    }
  }
}
```

## Directus

Docs: [Directus](https://docs.directus.io/reference/items.html) [docs].

- **Narrowest key:** A static token on a user whose role can only read the collections in the mapping (Directus roles are per collection, so this is a scoped key). Drafts are asked for with `drafts` and counted, never listed.
- **What it reads:** `GET /items/<collection>?limit=&offset=&sort=id&meta=filter_count&filter[status][_eq]=published&fields=...`; the answer is `data` and `meta.filter_count`. The token goes in `Authorization: Bearer <token>`. Field names (`status`, `slug`, `date_updated`) are the defaults of a collection with the system fields; change the paths if yours differ.
- **Example:** A pop-up restaurant whose `articles` collection holds the lunch menu and event notices; `date_updated` is empty until a first edit, so the mapping falls back to `date_created`.

```json title=directus.json
{
  "format": 1,
  "recipe": "directus",
  "name": "Directus",
  "settings": {
    "id": "generic-api",
    "fingerprint": {
      "article": ["title", "summary"]
    },
    "urls": {
      "article": "/news/{slug}"
    },
    "api": {
      "endpoint": "https://cms.example",
      "auth": {
        "header": "Authorization",
        "env": "GAUGELINE_DIRECTUS_TOKEN",
        "prefix": "Bearer "
      },
      "collections": {
        "article": {
          "path": "/items/articles",
          "query": {
            "filter[status][_eq]": "published",
            "meta": "filter_count",
            "sort": "id"
          },
          "items": "/data",
          "total": "/meta/filter_count",
          "pagination": {
            "style": "offset",
            "limit": "limit",
            "offset": "offset",
            "pageSize": 100
          },
          "published": {
            "path": "/status",
            "equals": "published"
          },
          "select": {
            "param": "fields",
            "always": ["id", "slug", "status", "date_updated", "date_created"]
          },
          "fields": {
            "id": "/id",
            "slug": "/slug",
            "updatedAt": ["/date_updated", "/date_created"],
            "publishedAt": "/date_created"
          }
        }
      },
      "drafts": {
        "collection": "article",
        "query": {
          "filter[status][_eq]": "draft"
        }
      }
    }
  }
}
```

## Drupal JSON:API

Docs: [Drupal JSON:API](https://www.drupal.org/docs/core-modules-and-themes/core-modules/jsonapi-module) [docs].

- **Narrowest key:** None for published content: the JSON:API module serves published nodes to anonymous visitors. If the site restricts it, add `auth` with the header the site accepts (for HTTP Basic, `Authorization` with prefix `Basic ` and the base64 of user and password in the variable); use a user whose role may only view published content.
- **What it reads:** `GET /jsonapi/node/<bundle>?page[limit]=50&page[offset]=&filter[status]=1`; the answer is `data`, each item with `attributes`. 50 is JSON:API's own maximum page size. The mapping asks the answer for `attributes.status` too.
- **Example:** A clinic's news articles on Drupal 10; the item's address comes from the path alias.

```json title=drupal-jsonapi.json
{
  "format": 1,
  "recipe": "drupal-jsonapi",
  "name": "Drupal JSON:API",
  "settings": {
    "id": "generic-api",
    "fingerprint": {
      "node--article": ["title"]
    },
    "api": {
      "endpoint": "https://clinic.example/jsonapi",
      "collections": {
        "node--article": {
          "path": "/node/article",
          "query": {
            "filter[status]": "1"
          },
          "items": "/data",
          "fieldRoot": "/attributes",
          "pagination": {
            "style": "offset",
            "limit": "page[limit]",
            "offset": "page[offset]",
            "pageSize": 50
          },
          "published": {
            "path": "/attributes/status",
            "equals": true
          },
          "select": {
            "param": "fields[{type}]",
            "always": ["title", "path", "changed", "created", "status"]
          },
          "fields": {
            "id": "/id",
            "url": "/attributes/path/alias",
            "updatedAt": "/attributes/changed",
            "publishedAt": "/attributes/created"
          }
        }
      }
    }
  }
}
```

## Prismic

Docs: [Prismic](https://prismic.io/docs/rest-api-technical-reference) [docs].

- **Narrowest key:** None for a public repository. A private repository needs an access token that Prismic reads from the address, which Gaugeline does not send (see Not yet).
- **What it reads:** `GET /api/v2` once, for the master ref; then `GET /api/v2/documents/search?ref=&page=&pageSize=`. The mapping reads the ref from `refs/0/ref` and checks `refs/0/isMasterRef` first.
- **Example:** A shop on Prismic and Next.js: one collection `documents` holds every type, so `types()` counts by each document's `type`.

```json title=prismic.json
{
  "format": 1,
  "recipe": "prismic",
  "name": "Prismic",
  "settings": {
    "id": "generic-api",
    "fingerprint": {
      "blog_post": ["title"]
    },
    "urls": {
      "blog_post": "/blog/{slug}"
    },
    "api": {
      "endpoint": "https://fernhill.cdn.prismic.io/api/v2",
      "bootstrap": [
        {
          "param": "ref",
          "path": "",
          "value": "/refs/0/ref",
          "expect": {
            "path": "/refs/0/isMasterRef",
            "equals": true
          }
        }
      ],
      "collections": {
        "documents": {
          "path": "/documents/search",
          "items": "/results",
          "total": "/total_results_size",
          "fieldRoot": "/data",
          "pagination": {
            "style": "page",
            "page": "page",
            "size": "pageSize",
            "pageSize": 100,
            "pages": "/total_pages"
          },
          "fields": {
            "id": "/id",
            "type": "/type",
            "slug": "/uid",
            "updatedAt": "/last_publication_date",
            "publishedAt": "/first_publication_date"
          }
        }
      }
    }
  }
}
```

## Hygraph

Docs: [Hygraph](https://hygraph.com/docs/api-reference/content-api) [docs].

- **Narrowest key:** A permanent auth token whose permissions allow reading the PUBLISHED stage only.
- **What it reads:** A GraphQL query sent as a GET, paged by cursor (`postsConnection`). Hygraph's own pages could not be read: that its Content API answers a GET is uncited. If it answers 405, the adapter says so (could-not-check, open question 53) and never sends a POST.
- **Example:** A bar's menu posts on Hygraph.

```json title=hygraph.json
{
  "format": 1,
  "recipe": "hygraph",
  "name": "Hygraph",
  "settings": {
    "id": "generic-api",
    "fingerprint": {
      "post": ["title"]
    },
    "urls": {
      "post": "/blog/{slug}"
    },
    "api": {
      "endpoint": "https://eu-central-1.cdn.hygraph.com/content/cl0invented0project/master",
      "auth": {
        "header": "Authorization",
        "env": "GAUGELINE_HYGRAPH_TOKEN",
        "prefix": "Bearer "
      },
      "collections": {
        "post": {
          "graphql": "query Posts($first: Int!, $after: String) { postsConnection(first: $first, after: $after, stage: PUBLISHED, orderBy: id_ASC) { edges { node { id slug updatedAt publishedAt __FIELDS__ } } pageInfo { endCursor hasNextPage } } }",
          "items": "/data/postsConnection/edges",
          "fieldRoot": "/node",
          "pagination": {
            "style": "cursor",
            "cursor": "after",
            "size": "first",
            "pageSize": 100,
            "next": "/data/postsConnection/pageInfo/endCursor",
            "more": "/data/postsConnection/pageInfo/hasNextPage"
          },
          "fields": {
            "id": "/node/id",
            "slug": "/node/slug",
            "updatedAt": "/node/updatedAt",
            "publishedAt": "/node/publishedAt"
          }
        }
      }
    }
  }
}
```

## DatoCMS

Docs: [DatoCMS](https://www.datocms.com/docs/content-delivery-api) [docs].

- **Narrowest key:** A read-only API token for the published environment.
- **What it reads:** A GraphQL query sent as a GET, paged by `first` and `skip`, with the count from `_allPostsMeta`. That the Content Delivery API answers a GET is uncited (the pages could not be read); a 405 is reported, and no POST is sent.
- **Example:** A florist's blog on DatoCMS.

```json title=datocms.json
{
  "format": 1,
  "recipe": "datocms",
  "name": "DatoCMS",
  "settings": {
    "id": "generic-api",
    "fingerprint": {
      "post": ["title"]
    },
    "urls": {
      "post": "/blog/{slug}"
    },
    "api": {
      "endpoint": "https://graphql.datocms.com",
      "auth": {
        "header": "Authorization",
        "env": "GAUGELINE_DATOCMS_TOKEN",
        "prefix": "Bearer "
      },
      "collections": {
        "post": {
          "graphql": "query Posts($first: IntType, $skip: IntType) { allPosts(first: $first, skip: $skip, orderBy: [_firstPublishedAt_ASC]) { id slug _updatedAt _firstPublishedAt __FIELDS__ } _allPostsMeta { count } }",
          "items": "/data/allPosts",
          "total": "/data/_allPostsMeta/count",
          "pagination": {
            "style": "offset",
            "limit": "first",
            "offset": "skip",
            "pageSize": 100
          },
          "fields": {
            "id": "/id",
            "slug": "/slug",
            "updatedAt": "/_updatedAt",
            "publishedAt": "/_firstPublishedAt"
          }
        }
      }
    }
  }
}
```

## Kontent.ai

Docs: [Kontent.ai](https://kontent.ai/learn/docs/apis/openapi/delivery-api/) [docs].

- **Narrowest key:** None for a public project. A project with secure access needs a key in `Authorization: Bearer <key>`: add `auth`.
- **What it reads:** `GET /<environment id>/items?limit=&skip=&includeTotalCount=true`; the answer is `items` and `pagination`. The slug is the element named `url`: change `/elements/url/value` to the codename of yours.
- **Example:** A gym with an `article` type on Kontent.ai.

```json title=kontent-ai.json
{
  "format": 1,
  "recipe": "kontent-ai",
  "name": "Kontent.ai",
  "settings": {
    "id": "generic-api",
    "fingerprint": {
      "article": ["title"]
    },
    "api": {
      "endpoint": "https://deliver.kontent.ai/00000000-0000-4000-8000-000000000000",
      "collections": {
        "items": {
          "path": "/items",
          "query": {
            "includeTotalCount": "true"
          },
          "items": "/items",
          "total": "/pagination/total_count",
          "fieldRoot": "/elements",
          "pagination": {
            "style": "offset",
            "limit": "limit",
            "offset": "skip",
            "pageSize": 100
          },
          "fields": {
            "id": "/system/id",
            "type": "/system/type",
            "slug": "/elements/url/value",
            "updatedAt": "/system/last_modified"
          }
        }
      }
    }
  }
}
```

## Joomla

Docs: [Joomla](https://docs.joomla.org/J4.x:Joomla_Core_APIs) [docs].

- **Narrowest key:** An API token (Joomla 4 and 5, Users, Edit, API token) for a user in a group that can only view content. Sent in `X-Joomla-Token`.
- **What it reads:** `GET /api/index.php/v1/content/articles?page[limit]=&page[offset]=`; the answer is `data`, each item with `attributes`. The mapping asks the item back for `state` 1 (published). Times have no zone and are read as UTC.
- **Example:** A physio clinic still on Joomla.

```json title=joomla.json
{
  "format": 1,
  "recipe": "joomla",
  "name": "Joomla",
  "settings": {
    "id": "generic-api",
    "fingerprint": {
      "article": ["title"]
    },
    "urls": {
      "article": "/{slug}"
    },
    "api": {
      "endpoint": "https://clinic.example/api/index.php/v1",
      "auth": {
        "header": "X-Joomla-Token",
        "env": "GAUGELINE_JOOMLA_TOKEN"
      },
      "collections": {
        "article": {
          "path": "/content/articles",
          "items": "/data",
          "fieldRoot": "/attributes",
          "pagination": {
            "style": "offset",
            "limit": "page[limit]",
            "offset": "page[offset]",
            "pageSize": 100
          },
          "published": {
            "path": "/attributes/state",
            "equals": 1
          },
          "fields": {
            "id": "/id",
            "slug": "/attributes/alias",
            "updatedAt": "/attributes/modified",
            "publishedAt": "/attributes/publish_up"
          }
        }
      }
    }
  }
}
```

## Storyblok

Docs: [Storyblok](https://www.storyblok.com/docs/api/content-delivery/v2) [docs].

- **Narrowest key:** The space's public access token (read-only by design).
- **What it reads:** `GET /v2/cdn/stories?version=published&page=&per_page=100`; the answer is `stories`, each with a `content` object whose `component` is the type.
- **Example:** A coach on Storyblok.

**Not usable yet.** Storyblok reads its key from the address (a query-string parameter), and Gaugeline sends a key only in a header, never in an address. The mapping below is tested against its recorded answers, but it is marked `blocked`, so a run asks for nothing and says why (could-not-check). The owner decides this in open question 53; until then, use the platform's native adapter when it exists, or the sitemap and feeds adapter.

```json title=storyblok.json
{
  "format": 1,
  "recipe": "storyblok",
  "name": "Storyblok",
  "settings": {
    "id": "generic-api",
    "fingerprint": {
      "post": ["title", "intro"]
    },
    "urls": {
      "post": "/blog/{slug}"
    },
    "api": {
      "endpoint": "https://api.storyblok.com/v2/cdn",
      "blocked": "key-in-address",
      "collections": {
        "story": {
          "path": "/stories",
          "query": {
            "version": "published"
          },
          "items": "/stories",
          "pagination": {
            "style": "page",
            "page": "page",
            "size": "per_page",
            "pageSize": 100
          },
          "fieldRoot": "/content",
          "fields": {
            "id": "/id",
            "type": "/content/component",
            "slug": "/slug",
            "url": "/full_slug",
            "updatedAt": "/published_at",
            "publishedAt": "/first_published_at"
          }
        }
      }
    }
  }
}
```

## Ghost

Docs: [Ghost](https://ghost.org/docs/content-api/) [docs].

- **Narrowest key:** A Content API key (read-only by design).
- **What it reads:** `GET /ghost/api/content/posts/?page=&limit=&fields=...`; the answer is `posts` and `meta.pagination`.
- **Example:** A newsletter site on Ghost.

**Not usable yet.** Ghost reads its key from the address (a query-string parameter), and Gaugeline sends a key only in a header, never in an address. The mapping below is tested against its recorded answers, but it is marked `blocked`, so a run asks for nothing and says why (could-not-check). The owner decides this in open question 53; until then, use the platform's native adapter when it exists, or the sitemap and feeds adapter.

```json title=ghost.json
{
  "format": 1,
  "recipe": "ghost",
  "name": "Ghost",
  "settings": {
    "id": "generic-api",
    "fingerprint": {
      "post": ["title"]
    },
    "urls": {
      "post": "/{slug}/"
    },
    "api": {
      "endpoint": "https://blog.example/ghost/api/content",
      "blocked": "key-in-address",
      "collections": {
        "post": {
          "path": "/posts/",
          "items": "/posts",
          "total": "/meta/pagination/total",
          "pagination": {
            "style": "page",
            "page": "page",
            "size": "limit",
            "pageSize": 100,
            "pages": "/meta/pagination/pages"
          },
          "select": {
            "param": "fields",
            "always": ["id", "slug", "url", "updated_at", "published_at"]
          },
          "fields": {
            "id": "/id",
            "slug": "/slug",
            "url": "/url",
            "updatedAt": "/updated_at",
            "publishedAt": "/published_at"
          }
        }
      }
    }
  }
}
```

## Builder.io

Docs: [Builder.io](https://www.builder.io/c/docs/content-api) [docs].

- **Narrowest key:** The space's public API key (read-only by design).
- **What it reads:** `GET /api/v3/content/<model>?limit=&offset=&includeUnpublished=false`; the answer is `results`, with `lastUpdated` in milliseconds.
- **Example:** A landing-page builder for a shop.

**Not usable yet.** Builder.io reads its key from the address (a query-string parameter), and Gaugeline sends a key only in a header, never in an address. The mapping below is tested against its recorded answers, but it is marked `blocked`, so a run asks for nothing and says why (could-not-check). The owner decides this in open question 53; until then, use the platform's native adapter when it exists, or the sitemap and feeds adapter.

```json title=builder-io.json
{
  "format": 1,
  "recipe": "builder-io",
  "name": "Builder.io",
  "settings": {
    "id": "generic-api",
    "fingerprint": {
      "page": ["title"]
    },
    "api": {
      "endpoint": "https://cdn.builder.io/api/v3",
      "blocked": "key-in-address",
      "collections": {
        "page": {
          "path": "/content/page",
          "query": {
            "includeUnpublished": "false"
          },
          "items": "/results",
          "fieldRoot": "/data",
          "pagination": {
            "style": "offset",
            "limit": "limit",
            "offset": "offset",
            "pageSize": 100
          },
          "fields": {
            "id": "/id",
            "url": "/data/url",
            "updatedAt": "/lastUpdated",
            "publishedAt": "/createdDate"
          }
        }
      }
    }
  }
}
```

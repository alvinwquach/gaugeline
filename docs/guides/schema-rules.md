# Checking structured data against your schema guide

Many teams keep a schema guide: one Organization and one WebSite node with fixed `@id` values, the
types each kind of page must carry, and how breadcrumbs start. Gaugeline checks the site against
that guide, so drift is caught on the next run instead of in the next audit.

## The guide

Put `gaugeline.schema.json` in the folder you run Gaugeline from (it moves into the config file
when that arrives):

```json
{
  "organizationId": "/#organization",
  "websiteId": "/#website",
  "templates": [
    { "match": "/blog/*", "require": ["Article", "WebPage", "BreadcrumbList"] },
    { "match": "/**", "require": ["WebPage"] }
  ],
  "breadcrumbs": { "firstName": "Home", "firstUrl": "/" }
}
```

- **`organizationId`, `websiteId`**: the one `@id` each node has. Ids are compared after resolving
  them against the page and trimming a trailing slash, so `/#organization` and
  `https://example.com/#organization` are the same id. The `#fragment` is part of the id.
- **`templates`**: `*` matches one path segment, `**` any depth. The most specific matching pattern
  applies. Common subtypes count: an `AboutPage` is a `WebPage`, a `BlogPosting` an `Article`.
- **`breadcrumbs`**: the name and address every BreadcrumbList starts with.

A file that is not valid stops the run with one sentence naming the field (exit code 2).

## What is checked

Gaugeline reads the checked page and the first 4 other same-site pages it links to (see
[Security](../security.md#how-much-a-run-requests)), and flattens each page's JSON-LD (arrays,
`@graph`, nested nodes) into a map by `@id`.

| Check                          | Needs the guide | Finds                                                                     |
| ------------------------------ | --------------- | ------------------------------------------------------------------------- |
| `schema-org-redefined`         | yes             | a page other than the homepage defining the Organization or WebSite again |
| `schema-id-drift`              | no              | an id other than the guide's, or, with no guide, two ids across pages     |
| `schema-template-missing-type` | yes             | a page lacking a type its template requires                               |
| `schema-breadcrumb-start`      | yes             | a breadcrumb that doesn't start at the guide's Home                       |
| `schema-breadcrumb-mismatch`   | yes             | a breadcrumb whose last item isn't the page's canonical                   |
| `schema-dangling-ref`          | no              | an `{"@id": ...}` reference to a node defined on none of the pages        |

With a guide but no structured data on any page checked, the run says it could not check, once,
instead of reporting every page. JSON-LD that doesn't parse is skipped by these checks (and reported
by `jsonld-invalid`).

## Example

Against the invented `northwind` fixture, five pages of a clinic chain with the guide above,
version 0.1.0 prints:

```text title=Output
! Pages redefine your organization instead of referring to it
    /about defines Organization /#organization with name, telephone instead of referencing /#organization
! A page is missing structured data its template requires
    /blog/new-clinic matches "/blog/*" but has no BreadcrumbList
· Breadcrumbs don't start where your guide says
    /blog/flu-season: the breadcrumb starts with "Start" at /; the guide says "Home" at /

Checked all 4 links, 1 image, all 5 sitemap pages, all 4 other pages, all 2 addresses in structured data.
3 to look at, none to fix first.
```

Each check that passed also prints a `✓ <id>` line, left out above. The output is asserted by
`packages/cli/src/__tests__/schema-rules.test.ts`.

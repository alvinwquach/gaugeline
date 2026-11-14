# Content model changes on Sanity: did every document and page keep up?

Available from version 0.2.0.

Extending a content type is the most common change on a Sanity site, and the quietest risky one. You
add a required `summary` to `article`; the 31 articles written since then have it, the 17 older ones
do not. The news page's query now filters on `summary`, so the page loads, every status is 200, and
17 articles have vanished from it. The "Latest from the clinic" strip on the home page used to show
three of them, and now it is empty. Nobody opened those pages again.

Gaugeline reads your schema and your published documents side by side with the pages built from them,
and tells you which of five things is wrong:

| Check                    | Level          | It says so when                                                                             |
| ------------------------ | -------------- | ------------------------------------------------------------------------------------------- |
| `model-missing-required` | Fix this first | Published documents lack a field the schema now requires (by type and field, with a count). |
| `model-unexpanded`       | Fix this first | A page shows a reference id, a type name or "[object Object]" where content should be.      |
| `model-listing-count`    | Fix this first | A listing shows fewer entries than there are published documents of its type.               |
| `model-dependents`       | Fix soon       | A block that embeds entries of a type shows none, and entries are published.                |
| `model-orphan-fields`    | Fix soon       | Documents still hold a value in a field the schema no longer has.                           |

They read and never write. The schema is a file on your disk. Sanity is asked with `GET` requests for
published documents only, and every answer is a count or a list of document ids: no document, title or
field value is requested, so nothing a client wrote reaches your computer, your CI or a report. See
[Content model changes](../privacy.md#content-model-changes). Run them only against sites and datasets
you own or have permission to read.

## Example: a physiotherapy clinic's news page

Fernbrook Physio (invented, like every business on this page) is a clinic whose freelancer built the
site on Next.js and Sanity. After a client asked for a short summary under every news card, the
freelancer made `summary` required on `article`, and rebuilt the news pages from a query that filters on
`summary`.

**1. Extract the schema, before and after.** `npx sanity schema extract` writes the schema of your
Studio to `schema.json` ([Sanity: schema extract](https://www.sanity.io/docs/apis-and-sdks/schema-extract),
[docs]). Keep the file from before the change too (`git show main:schema.json > schema.before.json`):
Gaugeline can then look for the fields you removed. Gaugeline makes no request to fetch either file.

**2. Say which pages are built from which types.** `gaugeline.model.json` sits next to your other
Gaugeline files. It holds paths, selectors, type and field names, never a key:

```json title="gaugeline.model.json"
{
  "schema": "schema.json",
  "previousSchema": "schema.before.json",
  "listings": [
    {
      "name": "News",
      "page": "/news",
      "type": "article",
      "item": "article.card"
    }
  ],
  "dependents": [
    {
      "name": "Latest from the clinic",
      "page": "/",
      "selector": "#insights li",
      "type": "article"
    }
  ],
  "idsShownOn": ["/dev/*"]
}
```

**3. Run it** on the home page, with your Sanity project id (and `SANITY_TOKEN`, a read-only Viewer
token, only for a private dataset):

```sh title=Terminal untested="Needs a Sanity project. packages/cli/src/__tests__/model-docs.test.ts runs this page's command against an invented dataset (48 published articles) and the invented fernbrook.example site, and compares the output."
$ SANITY_PROJECT_ID=fernbrook1 npx gaugeline fernbrook.example
```

```text title="Output (the lines these checks add)"
✗ A listing shows fewer entries than are published
    News shows 31 of 48 published "article" entries (2 pages of results). Not on the page: ids article-32, article-33, article-34, article-35, article-36, article-37, article-38, article-39, article-40, article-41 (the first ten).
✗ Published documents are missing a field the schema now requires
    17 of 48 published "article" documents have no "summary", which the schema now requires (ids article-32, article-33, article-34, and 14 more)
✗ A page shows a raw reference where content should be
    /services/sports-massage shows a raw reference (a _ref id) in its text: "Therapist: {"_type":"reference","_ref":"practitioner-ana"}" (reference id practitioner-ana)
! A block that shows entries of a type is empty
    Latest from the clinic on / shows no entries (nothing matches "#insights li"), and 48 "article" entries are published
! Documents still hold a field the schema no longer has
    2 of 6 published "practitioner" documents still have a value in "oldSpecialty", which the schema no longer has (ids practitioner-ben, practitioner-dee)
! Documents still hold a field the schema no longer has
    4 of 9 published "service" documents still have a value in "legacyNote", which the schema no longer has (ids service-01, service-02, service-03, and 1 more)
```

The findings tell one story. Seventeen published articles have no `summary` (`article-32` to
`article-48`, the first three named), and the same 17 are the ones missing from the news page: it shows
31 of 48 across its two pages of results. Gaugeline names the missing entries by id, not by title: it
never asks Sanity for a title. Open those ids in the Studio and fill the field in, or run a one-off
migration. The home page's strip is empty although 48 articles are published, so its query needs the
same attention. The sports massage page prints the practitioner reference as text where the
therapist's name should be: the query is missing a `->`. Two practitioners and four services still
carry fields the previous schema had and this one does not.

## What to put in the file

| Setting          | What it does                                                                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `schema`         | The extracted schema file, relative to the folder the command runs in. Without it the schema checks say they could not check, and the page checks still run.             |
| `previousSchema` | The schema from before the change. Fields it had and the current one lacks are looked for in the documents (`model-orphan-fields`).                                      |
| `retired`        | Fields you know were retired, by type: `{ "article": ["subtitle"] }`. Looked for the same way.                                                                           |
| `listings`       | A listing page: its `page`, document `type`, the `item` selector of its entries, an optional `filter`, a `next` selector, and the `slug` field (default `slug.current`). |
| `dependents`     | A block on a page: its `page`, the `selector` of its entries, the `type` it embeds, an optional `filter`, and the `block` name from a saved run (`--since last`).        |
| `idsShownOn`     | Pages (a trailing `*` means everything under it) where an id is shown on purpose, so `model-unexpanded` skips them.                                                      |

A `filter` is a GROQ condition such as `!(archived == true)`. Use it when a listing leaves entries out
on purpose, say a coach's archived programmes or a pop-up's past dates: only the documents that match
are counted against the page. It cannot hold `{`, `}` or `;`, and its brackets must balance.

## Things that are not mistakes

- **A field required only on some types.** Required is read per document type from the extract. The
  clinic's `practitioner` and `service` types have no summary and are not reported for it.
- **A listing that leaves some entries out.** Declare it with `filter`; the count then compares the
  page with the documents it was meant to show.
- **A reference shown as an id on purpose.** A developer page that lists document ids goes under
  `idsShownOn`. Image and file asset references (`image-...`, `file-...`) in a page's data are how
  Sanity stores a picture, so they are never reported.
- **Drafts.** Every question asks for the published perspective, so a draft is never counted.

## What it can't see

- **Fields no one named.** GROQ cannot list the keys a document has without sending the document, which
  Gaugeline never does. `model-orphan-fields` looks only for the fields in `previousSchema` and
  `retired`, and says so when neither is given.
- **Titles.** The spec asks for the titles of missing entries; Gaugeline names ids instead, because a
  title is content.
- **More entries than documents.** A page that shows more entries than are published (a cached copy of
  a deleted document) is not reported here.
- **Long listings.** A listing is followed through its next links for up to 10 pages; a longer one, or a
  page that cannot be read, is listed as could not check, never as a count. The listing and block pages
  come from the run's allowance of 16 pages shared with the switches and freshness files.
- **Rendered pages.** Pages are read as sent, without JavaScript. `model-unexpanded` reads the text,
  the addresses, and `__NEXT_DATA__` and other `application/json` blocks; it does not read the streamed
  payload of the Next.js app router.
- **Schema validation rules.** "Required" is what the extract says. A rule written as a custom function
  is not in it.

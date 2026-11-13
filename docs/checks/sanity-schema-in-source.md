# Sanity schema and queries: references and alt text

Two small gaps in a Sanity project's code make a client's site worse in ways nobody notices at launch: a query that returns an id where a name should be, and an image field an editor can publish with no description. A pub's menu notes ("written by", "in season") and its dish photos are exactly where both show up.

These two checks read the repository, not the live site.

| Check                         | Finds                                                                                            | Severity |
| ----------------------------- | ------------------------------------------------------------------------------------------------ | -------- |
| `groq-reference-not-expanded` | A GROQ query that lists a reference field and does not follow it with `->`                       | Fix soon |
| `image-alt-not-validated`     | An image field in the schema with no alt-text field, or one an editor is not required to fill in | Fix soon |

They only look. They read the files of a folder you name, through the static pack's reader: it never follows a link out of the folder, skips `node_modules` and `.git`, refuses `.env` files and anything that looks like a key, and caps what it reads. A check makes no request, runs no query and reads no dataset.

**A note on sources.** Documentation checked on: 2026-11-13. Sanity's documentation (sanity.io) could not be reached when this page was written (the build session's network policy refused it), so both checks are **uncited**: that `->` follows a reference, and what an image field's `fields` and `validation` do, are stated from the build's knowledge of Sanity, not from a page that was read. Gaugeline's tests pin the behaviour over invented schemas. Check the details against the [GROQ reference](https://www.sanity.io/docs/groq) and the [image type](https://www.sanity.io/docs/image-type) pages before relying on them. Grounded Code was not connected.

## Example: a pub's menu notes and dish photos

Quayside Taproom is an invented pub. Its Sanity project has a "menu note" with a writer and the seasons it applies to (both references to other documents), and a dish with a photo.

```text title=The folder
schemaTypes/post.ts           a menu note: a writer (reference) and seasons (array of references)
lib/queries.ts                the query the menu page runs
schemaTypes/dish.ts           a dish with a photo (an image field)
```

### A reference listed but not followed

```json title="Findings: groq-reference-not-expanded"
[
  {
    "checkId": "groq-reference-not-expanded",
    "severity": "medium",
    "title": "A query asks for a reference without following it",
    "evidence": "lib/queries.ts: the query asks for \"writer\" without ->, and schemaTypes/post.ts declares it as a reference.",
    "url": "source:./quayside-site",
    "source": {
      "file": "lib/queries.ts",
      "line": 5
    }
  },
  {
    "checkId": "groq-reference-not-expanded",
    "severity": "medium",
    "title": "A query asks for a reference without following it",
    "evidence": "lib/queries.ts: the query asks for \"seasons\" without ->, and schemaTypes/post.ts declares it as a reference.",
    "url": "source:./quayside-site",
    "source": {
      "file": "lib/queries.ts",
      "line": 6
    }
  }
]
```

A reference field holds a small object with the id of another document, not the document. The query lists `writer` and `seasons` as they are, so the page gets ids: a byline that is blank or reads `[object Object]`, and a list of seasons it cannot print.

**To fix it**, follow the reference and say what you want from it: `writer->{ name }`, and for a list `"seasons": seasons[]->title`.

### An image that can be published with no alt text

```json title="Findings: image-alt-not-validated"
[
  {
    "checkId": "image-alt-not-validated",
    "severity": "medium",
    "title": "An image field can be published with no alt text",
    "evidence": "schemaTypes/dish.ts: the image field \"photo\" has no required alt-text field.",
    "url": "source:./quayside-site",
    "source": {
      "file": "schemaTypes/dish.ts",
      "line": 8
    }
  }
]
```

The dish's photo has no field for a description. An editor can publish a dish with a picture and nothing for a screen reader to say. **To fix it**, add a field to the image, `defineField({ name: "alt", type: "string", validation: (Rule) => Rule.required() })`, and show it as the picture's `alt` on the page. Pictures already published need alt text written for them: that part is a job for the client or for you to schedule.

## What each check looks at

- **`groq-reference-not-expanded`.** The schema fields declared with `type: "reference"` (also as the members of an array of references), and the GROQ queries written as string or template literals that start with `*[`. A projection item that is exactly such a name, or an alias of it, and is not followed by `->` is a finding. `author._ref`, `defined(author)` and a filter on it are left alone.
- **`image-alt-not-validated`.** An object with `type: "image"` in a file that defines a schema (`defineType`, `defineField` or a `document` or `object` type). Its `fields` must hold a field named `alt`, `altText` or `alt_text` whose `validation` calls `required(`. An image used as a member of an array is read the same way.

## What it does not cover

- `groq-reference-not-expanded` does not know a field's type outside the schema in the folder. If another type has a field with the same name that is not a reference, a query on it is a false positive; rename the field or follow the reference to silence it. Queries kept in `.groq` files, built from pieces or in another repository are not read.
- It does not run the query or look at the data.
- `image-alt-not-validated` does not follow a named type: a shared image type is read where it is defined. It does not look at how the page uses the alt text, and the page-side half (an image block with no picture) is the job of `images-broken` on the live site.

## When it cannot check

If the folder holds no Sanity schema, the checks say so: they cannot know which fields are references or images. `groq-reference-not-expanded` also says so when no query is written as a string in the source. A source file that was left out (too large, not readable, a link) is reported the same way, and a folder with more files than Gaugeline reads never passes.

[Every check, with what it catches and how to fix it](/docs/checks)

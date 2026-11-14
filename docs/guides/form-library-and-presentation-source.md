# A form library in the browser and visual editing with no routes, read from your code

Two more things in a Next.js and Sanity build cost little on launch day and a little for as long as the site lives: a form that sends its whole validation library to every visitor only to list its field names, and a visual-editing setup that does not say which page shows which document. Neither breaks a page. Both are "worth knowing", the lowest level Gaugeline reports, and both are visible only in the code.

These checks read your repository, not the live site, so they work before the site is deployed. They belong to the static checks, which read a folder of source and make no request. They only read. Gaugeline never runs your code, never opens a `.env` file or a key file, and never prints what it finds in a file: a finding names the file and the line, and says what is wrong in Gaugeline's own words.

**A note on sources.** Documentation checked on: 2026-11-13. The Next.js and Sanity documentation sites could not be reached when this page was written (the build session's network policy refused them), so what was read is the official Markdown or type source on GitHub [docs]. For the first check: Next.js 16.4.1, [Server and Client Components](https://raw.githubusercontent.com/vercel/next.js/v16.4.1/docs/01-app/01-getting-started/05-server-and-client-components.mdx), line 180: once a file is marked `"use client"`, "all of its imports and the components it directly renders are included in the client bundle"; and the [Zod object documentation](https://raw.githubusercontent.com/colinhacks/zod/b500a2ee95134f81d74da7911d7378dd2853d042/packages/docs/content/api.mdx) at the commit npm records for 4.6.7, lines 1293 to 1319, for `.shape` and `.keyof()`. How large the library is, and that a plain list is the better shape, are **uncited**. For the second check: Sanity's [Presentation types](https://raw.githubusercontent.com/sanity-io/sanity/main/packages/sanity/src/presentation/types.ts), read on `main` (the 6.23.0 tag was not read): the options have `resolve.mainDocuments`, and a document resolver maps a `route` to a document by `type`, a `filter` or a `resolve` function. The message the editor sees when no route is mapped ("Missing a main document") is **uncited**: Sanity's page was unreachable. Grounded Code was not connected.

## A form that loads its validation library to read field names

`form-validation-in-client-bundle` (worth knowing) finds a client component (a file that starts with `"use client"`) that imports a schema from a module that loads zod, yup, valibot, joi, superstruct or arktype, or defines one itself, and whose only use of the schema is to read its field names: `.shape`, `.keyof()`, `.entries` or `.fields`.

Everything a client component imports goes to the visitor's browser. The library and the schema with all its rules are downloaded on every page with the form, so the page can list a few field names that a plain array would hold.

- A client file that validates with the schema (`parse`, `safeParse`, `validate`, a form library's resolver) passes: the browser needs the library.
- A schema used only as a type (`typeof schema`, `z.infer`) passes: nothing of it is sent.
- A schema that is assigned, passed on or exported, a use Gaugeline cannot read, is reported as could not check.

Larkfield Bakery is an invented bakery with a private-order form. Its form component lists the fields from the same zod schema the server action uses.

Each example names its check with `--only`, so a check added to Gaugeline later does not change what the page prints.

<!-- source-fixture: form-validation-in-client-bundle/fail -->

```sh title=Terminal untested="The docs runner points every example at a fixture website, and this command reads a folder. packages/cli/src/__tests__/source-form-presentation-docs.test.ts runs the same command on the same invented folder (packages/fixtures/source/form-validation-in-client-bundle/fail) and compares the Output block with what it prints."
$ npx gaugeline source ./larkfield-bakery --only form-validation-in-client-bundle
```

```sh title=Output
Read 3 files in ./larkfield-bakery. No request was made and no code was run.

· A form loads its validation library into the browser only to read field names
    components/EnquiryForm.tsx:3: this client component imports lib/enquiry-schema.ts, which loads zod, and only reads field names from it.

1 to look at, none to fix first.
```

The fix is a plain list the form can import, with the schema left on the server:

```ts
export const ENQUIRY_FIELDS = ["name", "email", "guests", "date"] as const;
```

## Visual editing with no route mapped to a document

`presentation-main-documents-missing` (worth knowing) finds a call of `presentationTool` (from `sanity/presentation` or `@sanity/presentation`) whose options are written in the call and have no `resolve.mainDocuments`: no `resolve` option, a `resolve` with only `locations`, or an empty list.

Presentation shows the site inside the studio. It can open the document behind a page only when it is told which route shows which document. Without that, an editor looking at a page in the preview cannot jump to the document to edit it.

- A `resolve.mainDocuments` with at least one entry passes. Gaugeline does not compare the routes with the pages of the site.
- Options held in a variable, a spread, or a `resolve` that is not written in the call are reported as could not check.

The same bakery's studio turns on Presentation and leaves out the mapping.

<!-- source-fixture: presentation-main-documents-missing/fail -->

```sh title=Terminal untested="The docs runner points every example at a fixture website, and this command reads a folder. packages/cli/src/__tests__/source-form-presentation-docs.test.ts runs the same command on the same invented folder (packages/fixtures/source/presentation-main-documents-missing/fail) and compares the Output block with what it prints."
$ npx gaugeline source ./larkfield-bakery --only presentation-main-documents-missing
```

```sh title=Output
Read 1 file in ./larkfield-bakery. No request was made and no code was run.

· Visual editing is set up with no route mapped to a document
    sanity.config.ts:12: presentationTool has no resolve option, so no route is mapped to a document.

1 to look at, none to fix first.
```

The fix is one `resolve.mainDocuments` entry for each kind of page:

```ts
resolve: {
  mainDocuments: defineDocuments([
    { route: "/menu/:slug", filter: `_type == "dish" && slug.current == $slug` },
    { route: "/", type: "homePage" },
  ]),
},
```

## What they do not cover

- `form-validation-in-client-bundle` follows one local import, not a chain, and does not see a client component that imports a plain list from a module that also loads the library for the server. It only knows schemas declared as `const x = <lib>.object(...)`, `object(...)` or `type(...)`.
- `presentation-main-documents-missing` does not check that each route in the list matches a page, or that the filters are right.
- Neither check says what the browser downloads or what the editor sees; both are about the shape of the code.

## When it cannot check

If the folder holds no source file, or a source file was left out (too large, not readable, a link), the checks say they could not check, with that reason, and never that they passed. A folder with more files than Gaugeline reads never passes either.

[Every check, with what it catches and how to fix it](/docs/checks)

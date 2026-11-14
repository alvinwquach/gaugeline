# Page sections and Sanity's hidden editing text

Two things go wrong between a Sanity schema and the page it feeds, and both only show to an editor: a section the editor can add that the page never draws, and the hidden text that makes click-to-edit work leaking into a comparison or a link.

These two checks read the repository, not the live site.

| Check                             | Finds                                                                                             | Severity |
| --------------------------------- | ------------------------------------------------------------------------------------------------- | -------- |
| `section-type-component-mismatch` | A section the schema lets editors add that has no component, or a component that has no section   | Fix soon |
| `stega-not-cleaned`               | Click-to-edit is on, and fetched text is compared, linked or put in metadata without `stegaClean` | Fix soon |

They only look. They read the files of a folder you name, through the static pack's reader: it never follows a link out of the folder, skips `node_modules` and `.git`, refuses `.env` files and anything that looks like a key, and caps what it reads. A check makes no request, runs no code and reads no dataset.

**A note on sources.** Documentation checked on: 2026-11-13. The `@sanity/client` README was read as the official Markdown source on GitHub (the main branch, version not pinned, because Sanity's own documentation site could not be reached) [docs]: [@sanity/client README](https://raw.githubusercontent.com/sanity-io/client/main/README.md) (lines 802 and 863 to 896: with stega on, edit links are encoded into string values, and `stegaClean` from `@sanity/client/stega` cleans them before they are compared). That is all `stega-not-cleaned` is cited for. That a link, an attribute or a page title also breaks is an inference from the same text and is **uncited**, as is how a page builder maps a section to a component (a pattern, not a documented behaviour). Grounded Code was not connected.

## Example: a pub's page builder

Quayside Taproom is an invented pub. Its pages are built from sections an editor adds in Sanity: a hero and a menu gallery. Click-to-edit is on in preview.

```text title=The folder
schemaTypes/page.ts           the page type: sections can be a hero or a menuGallery
components/Sections.tsx       draws each section by its type
lib/live.ts, app/page.tsx     defineLive for click-to-edit; the page that fetches and shows content
```

### A section the page never draws

```json title="Findings: section-type-component-mismatch"
[
  {
    "checkId": "section-type-component-mismatch",
    "severity": "medium",
    "title": "A page section and its component do not match",
    "evidence": "schemaTypes/page.ts: the section type \"menuGallery\" has no component in the renderer, so it renders nothing.",
    "url": "source:./quayside-site",
    "source": {
      "file": "schemaTypes/page.ts",
      "line": 10
    }
  }
]
```

The schema lists `menuGallery`, and the renderer's map has no entry for it. An editor adds a gallery to the page, publishes, and the page looks the same. **To fix it**, add the component to the map, or take the section out of the schema's list. A component the renderer has that no schema section matches is reported the other way round.

### Text that is not the text it looks like

```json title="Findings: stega-not-cleaned"
[
  {
    "checkId": "stega-not-cleaned",
    "severity": "medium",
    "title": "Sanity's hidden editing text is not cleaned where it must be",
    "evidence": "app/page.tsx: stega is on, and a fetched value is compared with a string without stegaClean.",
    "url": "source:./quayside-site",
    "source": {
      "file": "app/page.tsx",
      "line": 6
    }
  },
  {
    "checkId": "stega-not-cleaned",
    "severity": "medium",
    "title": "Sanity's hidden editing text is not cleaned where it must be",
    "evidence": "app/page.tsx: stega is on, and a link or attribute is built from a fetched value without stegaClean.",
    "url": "source:./quayside-site",
    "source": {
      "file": "app/page.tsx",
      "line": 7
    }
  }
]
```

With click-to-edit on, the text a query returns has hidden characters inside it. `data.layout === "wide"` is then false even when the editor typed "wide", and `href={data.bookingUrl}` carries the characters into the link. The finding appears only in preview, which is why it is easy to miss. **To fix it**, wrap the value: `stegaClean(data.layout)`, `href={stegaClean(data.bookingUrl)}`. Leave visible text as it comes, so click-to-edit keeps working.

## What each check looks at

- **`section-type-component-mismatch`.** The type names listed as members of an array field called `sections`, `blocks`, `pageBuilder`, `content` or `modules` in the files that define a schema, against the renderer: the files outside the schema that mention `_type`. A section name that appears in no renderer file (as a `case`, a comparison, a quoted key or a map key) is a finding. A renderer map is an object with two or more `name: Component` entries; one of its keys that matches no schema name is a finding.
- **`stega-not-cleaned`.** First the setup: `stega:` set to `true` or an object, `defineLive`, `VisualEditing` or `studioUrl`. With none, nothing is encoded, and the check passes. Then, in each file that fetches Sanity content (`.fetch(`, `sanityFetch(`, `urlFor(`) and never mentions `stegaClean`: a metadata title or description built from a property, a property compared with a string (fields that start with an underscore are left alone, and so are `process.env`, `request` and similar), and an `href`, `src`, `id`, `target` or `rel` built from a property.

## What it does not cover

- `section-type-component-mismatch` does not follow a renderer built another way (a lookup table in another package, a component picked by a naming rule). A section name that appears quoted anywhere in a renderer file counts as handled, so it can miss a section that is mentioned but not drawn.
- `stega-not-cleaned` works per file: a value cleaned in one file and used in another is flagged in the second if that file fetches content and does not mention `stegaClean`. It does not read a component that receives the text as a prop and fetches nothing.
- "Over-cleaned visible text" (click-to-edit lost) needs a rendered page and is not read here.

## When it cannot check

`section-type-component-mismatch` says it could not check when the folder holds no array of section types in a Sanity schema, or no page renderer. A source file that was left out (too large, not readable, a link) is reported the same way for both, and a folder with more files than Gaugeline reads never passes.

[Every check, with what it catches and how to fix it](/docs/checks)

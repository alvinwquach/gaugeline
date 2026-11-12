---
notReleased: true
---

# The publish gate

How a publish gets checked, and its one honest limit.

::: warning
<b>Not released yet.</b> The first part, the Function that checks the page after every publish, is built and described here. The part that keeps the Publish button disabled follows in the next release (0.2).
:::

1. An editor clicks Publish, or a script writes through the API.
2. The document is published. A Sanity Function receives it, works out which page it renders to, and checks that page with the same checks `gaugeline` runs.
3. If the page is right, nothing happens. If not, the Function reports what is wrong and links each problem to the address it is about.

## The honest limit

The button stops people. A script with an API token can write directly and go around it, so the Function also checks again right after every publish. Anything that slipped past becomes a finding instead of a surprise. One without the other is either bypassable or too late.

The Function is a smoke alarm, not a lock. It reads the live page after the document is already published, so it tells you within seconds, and it cannot take a publish back.

## What it can touch

Nothing is written. The Function gets the published document in its event, so it needs no Sanity client and no token, and it never reads the token Sanity hands every Function. It reads one page of your site with GET and HEAD, the same way `gaugeline` does, and refuses private addresses. It does not run the probing checks or the DNS checks.

## Set it up

A document in the event has to carry the fields the page address needs, so ask for them in the blueprint's projection. This example is for a bar that sells cocktail kits: pages live at `/slug`, products at `/shop/category/slug`, and the settings document is not a page.

```ts title=sanity.blueprint.ts
import { defineBlueprint, defineDocumentFunction } from "@sanity/blueprints";

export default defineBlueprint({
  resources: [
    defineDocumentFunction({
      name: "publish-gate",
      event: {
        on: ["publish"],
        filter: "_type in ['page', 'product']",
        projection: "{_id, _type, slug, 'category': category->{slug}}",
      },
    }),
  ],
});
```

```ts title=functions/publish-gate/index.ts
import { documentEventHandler } from "@sanity/functions";
import { gateHandler } from "sanity-plugin-publish-gate/function";

const gate = gateHandler({
  site: "https://lantern-yard.example",
  pages: {
    page: "/{slug}",
    product: "/shop/{category.slug}/{slug}",
    siteSettings: null,
  },
});

export const handler = documentEventHandler(async ({ event }) => {
  await gate({ event });
});
```

A rule is a template, a function that returns a path, or `null` for a document that is not a page. A slug is data: only letters, digits and `. _ ~ -` (joined by `/`) go into an address, and an address can never leave `site`. A document whose type has no rule is not gated.

## What you see

Say the editor of the bar's site renames a cocktail through a script, and the menu page still links to the old page. This runs the same check on a stand-in of that site:

```ts title=try-the-gate.ts untested="Needs the bar's live site. packages/sanity-plugin-publish-gate/src/__tests__/docs.test.ts runs this code against an invented copy of it in memory and compares the output with the block below."
import { checkDocument } from "sanity-plugin-publish-gate/function";

const outcome = await checkDocument(
  { _id: "menu-page", _type: "page", slug: { current: "menu" } },
  { site: "https://lantern-yard.example", pages: { page: "/{slug}" } },
);

console.log(outcome.status, outcome.url);
if (outcome.status === "slipped")
  for (const f of outcome.findings) console.log(f.severity.padEnd(4), f.id, f.evidence);
```

```text title=Output
slipped https://lantern-yard.example/menu
high broken-links "Old cocktails" <a href="/menu/old-cocktails"> returned 404
```

The handler records that outcome as one JSON line in the Function's log. To send it somewhere else, pass `report`:

```ts
gateHandler({ site, pages, report: (outcome) => notifyTheStudio(outcome) });
```

## The four answers

| Status            | Meaning                                                                         | Reported |
| ----------------- | ------------------------------------------------------------------------------- | -------- |
| `clean`           | The page has nothing at or above `blockOn` (default `high`).                    | No       |
| `slipped`         | The page has problems. `findings` lists each with its check, severity and link. | Yes      |
| `not-gated`       | A draft, or a document that renders to no page (settings). Nothing was read.    | No       |
| `could-not-check` | The site is down, the page answered an error, or the slug cannot be trusted.    | Yes      |

A check that could not run is never a pass. If the site is down, the Function says so.

If your site rebuilds after a publish, the page may still be the old one for a moment. Set `settleMs` to wait before the page is read.

## What is not here yet

- The disabled Publish button, with the reasons and a link to each problem, and the choice of failing open or closed with an override that records who and why (the next release).
- Where findings are kept. The Function does not write to your dataset, so a finding lives in the Function's log or in whatever `report` sends it to.

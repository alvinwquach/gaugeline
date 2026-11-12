---
notReleased: true
---

# The publish gate

How a publish gets checked, and its one honest limit.

::: warning
<b>Not released yet.</b> Built and described here: the Function that checks the page after every publish, the request the Publish button makes to a Function you own, and the button itself (0.2).
:::

1. An editor clicks Publish, or a script writes through the API.
2. The document is published. A Sanity Function receives it, works out which page it renders to, and checks that page with the same checks `gaugeline` runs.
3. If the page is right, nothing happens. If not, the Function reports what is wrong and links each problem to the address it is about.

## The honest limit

The button stops people. A script with an API token can write directly and go around it, so the Function also checks again right after every publish. Anything that slipped past becomes a finding instead of a surprise. One without the other is either bypassable or too late.

The Function is a smoke alarm, not a lock. It reads the live page after the document is already published, so it tells you within seconds, and it cannot take a publish back.

## What it can touch

Nothing is written. The Function gets the published document in its event, so it needs no Sanity client and no token, and it never reads the token Sanity hands every Function.

It reads the page, and only the page: one GET of it, plus a HEAD (then a GET if the site refuses HEAD) of each link on that page that points at the same host, to find dead ones. A request to any other host is never made: a link to `www.` of your site counts as another host, a link that redirects to another site is stopped at the redirect, and the report lists these as `redirect-off-site` under `couldNotCheck`. A page that itself redirects to another host is could-not-check. The Function does not fetch robots.txt, the sitemap, llms.txt, scripts, images or feeds, so the checks that need those do not run in the gate; run `gaugeline` on the whole site for them. It uses the same read-only fetcher as `gaugeline`, which refuses private and metadata addresses, and it does not run the probing checks or the DNS checks. A draft and a release version are not published, so they are not checked.

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

## Where a request goes and what is sent

The Publish button asks one question: is this page right? It asks it of a Function **you own**, at an https address you configure. Nothing is stored anywhere, not in your dataset and not by Gaugeline: the answer is shown in the Studio and gone when the session ends.

|          |                                                                                                                                               |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| From     | The browser that is running your Studio.                                                                                                      |
| To       | The one https address you set as `functionUrl`. Not Gaugeline, not Sanity, not your site.                                                     |
| Method   | `GET`, with no body.                                                                                                                          |
| Sent     | The page's public address, as `?url=`. The only header is `Accept: application/json`.                                                         |
| Not sent | The document or any field of it, a Sanity token, a cookie, an `Authorization` header, the editor's name or email, a referrer.                 |
| Refused  | An address that is not https, that holds a user name or password, a `*`, a query or a fragment. A redirect is never followed.                 |
| Bounded  | At most 15 seconds to the whole reply, at most 64 KiB of it.                                                                                  |
| Checked  | The reply must match one fixed shape. Anything else is "could not check", never a pass.                                                       |
| Shown    | Every piece of page text is cleaned (hidden and direction-changing characters removed, length capped) and shown as plain text, never as HTML. |

The Function reads only your own site: it refuses any address that is not on `site` (same scheme, host and port, no user name or password) before it requests anything. It answers a browser only when the browser's origin is the one `allowOrigin` you name, exactly: no wildcard. It holds no Sanity token and sends only `GET` and `HEAD` to your own host.

Two limits, stated plainly. `allowOrigin` decides who can read the answer, not who can ask: anyone who knows the address can ask it to check a page of your site (and only your site), so it caches an answer for 10 seconds and shares one check between two editors who publish the same page at once. And the check reads the live page: to check a draft before it is published, point `site` at a preview deployment that shows drafts.

This is the Function. It takes a standard `Request` and gives a standard `Response`, so it mounts on any host you own that does the same: a serverless route or a plain Node server.

```ts title=functions/gate/index.ts
import { gateRequestHandler } from "sanity-plugin-publish-gate/function";

export const handle = gateRequestHandler({
  site: "https://lantern-yard.example",
  allowOrigin: "https://lantern-yard.sanity.studio",
});
```

The Studio's side is `requestGate`. This runs the same call against that handler on an invented copy of the bar's site, with the browser's `fetch` replaced by a call to the handler:

```ts title=try-the-request.ts untested="Needs the bar's live site and a hosted Function. packages/sanity-plugin-publish-gate/src/__tests__/docs.test.ts runs this code against an invented copy of the site in memory and compares the output with the blocks below."
import { requestGate } from "sanity-plugin-publish-gate";
import { gateRequestHandler } from "sanity-plugin-publish-gate/function";

const handler = gateRequestHandler({
  site: "https://lantern-yard.example",
  allowOrigin: "https://lantern-yard.sanity.studio",
});
const sent: string[] = [];

const answer = await requestGate({
  functionUrl: "https://gate.lantern-yard.example/check",
  pageUrl: "https://lantern-yard.example/menu",
  fetch: (url, init) => {
    sent.push(`${init?.method} ${url}`);
    sent.push(
      `credentials=${init?.credentials} redirect=${init?.redirect} referrer=${init?.referrerPolicy}`,
    );
    return handler(
      new Request(String(url), { headers: { origin: "https://lantern-yard.sanity.studio" } }),
    );
  },
});

console.log(sent.join("\n"));
console.log(answer.status, answer.url);
for (const f of answer.findings) console.log(f.severity.padEnd(4), f.id, f.evidence);
```

```text title=Request
GET https://gate.lantern-yard.example/check?url=https%3A%2F%2Flantern-yard.example%2Fmenu
credentials=omit redirect=error referrer=no-referrer
```

```text title=Reply
findings https://lantern-yard.example/menu
high broken-links "Old cocktails" <a href="/menu/old-cocktails"> returned 404
```

The reply has one fixed shape: `version` (1), `status` (`clean`, `findings` or `could-not-check`), `url`, `checkedAt`, `findings` (each with `id`, `severity`, `title`, `evidence` and `url`) and, for `could-not-check`, a `reason`. A reply about a different page than the one asked for is refused, and so is a reply with a field not named here, a content type other than `application/json` (a utf-8 charset is allowed) or a reply that is not valid JSON. `findings` holds only the problems at or above `blockOn`.

## The Publish button

`publishGate` is a Studio plugin. It wraps Sanity's own Publish action: the first click asks your Function whether the page this document renders to is right. A page that is right publishes at once. A page with problems, or a check that could not run, holds the button, says why, and links each problem on your site. The plugin does not publish or write anything itself: the only thing that publishes is Sanity's own Publish action, which it calls.

```ts title=sanity.config.ts
import { defineConfig } from "sanity";
import { publishGate } from "sanity-plugin-publish-gate";

export default defineConfig({
  // ...
  plugins: [
    publishGate({
      site: "https://lantern-yard.example",
      functionUrl: "https://gate.lantern-yard.example/check",
      pages: { page: "/{slug}", product: "/shop/{category.slug}/{slug}", siteSettings: null },
    }),
  ],
});
```

`pages` is the same table the Function uses. A document that renders to no page (settings) is not gated: its Publish button is Sanity's own and nothing is requested. A wrong setup (an http or wildcard `functionUrl`, a `site` that is not a web address) stops the Studio when it loads, not at the first click.

### The six states

| State                | What the editor sees                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------- |
| `idle`               | Sanity's own Publish button.                                                                                    |
| `checking`           | "Checking the page..." and the button is disabled. A second click asks nothing more.                            |
| `clean`              | The page is right. Sanity's Publish runs.                                                                       |
| `findings`           | "Held: 2 problems". A dialog lists each problem with its severity and a link to it.                             |
| `could-not-check`    | "Held: could not check the page". The site is down, the page answered an error, or the Function is unreachable. |
| `override-confirmed` | "Publish (overridden)". A person confirmed publishing anyway.                                                   |

A check that could not run is never a pass: by default it holds the button like a problem does. Set `failOpen: true` to let a check that could not run through; a page that has problems is still held. Editing the document after an answer clears it, so an override covers the document as it stood when the person confirmed, not the next edit.

```ts title=try-the-states.ts untested="Needs a Studio. packages/sanity-plugin-publish-gate/src/__tests__/docs.test.ts runs the state machine of this example and compares the output with the block below."
import { IDLE, gateReduce } from "sanity-plugin-publish-gate";

const url = "https://lantern-yard.example/menu";
const found = {
  version: 1,
  status: "findings",
  url,
  checkedAt: "2026-11-12T10:00:00Z",
  findings: [],
};
let state = IDLE;
for (const event of [
  { type: "check", url },
  { type: "answer", answer: found },
  { type: "confirm-override" },
  { type: "reset" },
]) {
  state = gateReduce(state, event);
  console.log(event.type.padEnd(16), state.name);
}
```

```text title=States
check            checking
answer           findings
confirm-override override-confirmed
reset            idle
```

### The override

To publish a held page, a person clicks "Publish anyway" in the dialog that names every problem. Nothing the plugin does by itself publishes. The override is not logged anywhere: not in your dataset, not in the browser's storage, not in a request. It lives in the Studio session's memory and is gone when the tab closes. If you need a record of who published over a hold, that is Sanity's own history of the document.

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

- A recheck of the pages that reference a document you publish, and an email when the gate holds a publish. These are follow-ups, not in this release.
- Where findings are kept. The Function does not write to your dataset, so a finding lives in the Function's log or in whatever `report` sends it to.

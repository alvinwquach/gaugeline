# Wasted cache clears and a client in the config, read from your code

Two habits in a Next.js and Sanity build cost a site nothing you would notice on the day it launches, and a little every week after: a publish webhook that clears the cache for a draft, and a content client created in the framework's config file. Neither breaks a page. Both are "worth knowing", the lowest level Gaugeline reports, and both are visible only in the code.

These checks read your repository, not the live site, so they work before the site is deployed. They belong to the static checks, which read a folder of source and make no request. They only read. Gaugeline never runs your code, never opens a `.env` file or a key file, and never prints what it finds in a file: a finding names the file and the line, and says what is wrong in Gaugeline's own words.

**A note on sources.** Documentation checked on: 2026-11-13. Sanity's documentation site and the Next.js documentation site could not be reached when this page was written (the build session's network policy refused them), so what was read is the official Markdown source on GitHub [docs]. For the first check, [revalidateTag](https://raw.githubusercontent.com/vercel/next.js/v16.4.1/docs/01-app/03-api-reference/04-functions/revalidateTag.mdx) in Next.js 16.4.1: it "marks the tagged data as stale". That supports what a cache clear is, and nothing more: that Sanity gives a draft an id that starts with `drafts.` and a release version one that starts with `versions.`, and which documents a webhook is sent for, are **uncited**. For the second check, that a client in the config forces a fake setting into tests and runs its setup at build time is **uncited**: it is the reason for the check, and the check says only what the code does. Grounded Code was not connected.

## A publish webhook that clears the cache for a draft

`webhook-purges-draft-ids` (worth knowing) finds the code that receives the publish webhook (a file that imports `@sanity/webhook` or `next-sanity/webhook`, reads the `sanity-webhook-signature` header, or is a route that revalidates behind a secret) when it clears the cache for a document id and nothing in it skips an id that starts with `drafts.` or `versions.`.

Sanity keeps a draft under an id that starts with `drafts.`. If the webhook is also sent for drafts, every save clears the cache: the site refetches content no visitor can see, and an editor typing for an afternoon keeps the cache cold. If the webhook is set to send published documents only, the code needs no guard, and Gaugeline cannot see that setting.

- A receiver that mentions `"drafts."` or `"versions."` in its code (a `startsWith`, a pattern), or calls `getPublishedId`, `isDraftId`, `isVersionId` or `isPublishedId`, passes.
- A receiver that reads the id and clears the cache with none of those is a finding.
- A receiver that clears the cache and never reads an id is reported as could not check: the webhook's own settings in Sanity may already exclude drafts, and Gaugeline does not call that a pass.

Larkfield Bakery is an invented bakery. Its site clears the cached menu when the owner publishes, and its receiver clears a tag for the document's type and one for its id.

Each example names its check with `--only`, so a check added to Gaugeline later does not change what the page prints.

<!-- source-fixture: webhook-purges-draft-ids/fail -->

```sh title=Terminal untested="The docs runner points every example at a fixture website, and this command reads a folder. packages/cli/src/__tests__/source-purges-config-docs.test.ts runs the same command on the same invented folder (packages/fixtures/source/webhook-purges-draft-ids/fail) and compares the Output block with what it prints."
$ npx gaugeline source ./larkfield-bakery --only webhook-purges-draft-ids
```

```sh title=Output
Read 1 file in ./larkfield-bakery. No request was made and no code was run.

· A publish webhook clears the cache for draft ids too
    app/api/revalidate/route.ts:15: this receiver reads the document id and clears the cache, and nothing in it skips an id that starts with drafts. or versions.

1 to look at, none to fix first.
```

The fix is one early return, before the cache is cleared, or one setting in Sanity:

```ts
if (body._id.startsWith("drafts.") || body._id.startsWith("versions.")) {
  return Response.json({ revalidated: false });
}
```

## A content client created when the config file loads

`cms-client-in-framework-config` (worth knowing) looks at the framework's config files (`next.config`, `nuxt.config`, `astro.config`, `svelte.config`, `remix.config`, `vite.config`, `react-router.config` and `gatsby-config`) and finds one that creates a client for a content system (Sanity, Contentful, Prismic, Directus, DatoCMS, Storyblok, Contentstack, Kontent, Ghost or Strapi) when the file loads, or that imports a local module which does.

A config file is read by every build, every test run and every tool that imports it. A client made at the top of it needs the project's settings in all of them, so a fake project id ends up in each, and its setup runs at build time whether or not a page needs it. Keep the config free of clients: make the client in the function that reads content, and keep the few values the config needs (a redirect list, an image host) as plain data, or write them to a file in a script that runs before the build.

- A client made inside a function (a `redirects()` method, an arrow function) passes: it runs when the function is called, not when the file loads.
- A client made at the top level, or inside the exported object where it is built when the file loads, is a finding.
- A config that imports `./lib/sanity` is a finding when that module makes its client at the top level.

The same bakery's config asks Sanity for a list of moved pages when it loads.

<!-- source-fixture: cms-client-in-framework-config/fail -->

```sh title=Terminal untested="The docs runner points every example at a fixture website, and this command reads a folder. packages/cli/src/__tests__/source-purges-config-docs.test.ts runs the same command on the same invented folder (packages/fixtures/source/cms-client-in-framework-config/fail) and compares the Output block with what it prints."
$ npx gaugeline source ./larkfield-bakery --only cms-client-in-framework-config
```

```sh title=Output
Read 1 file in ./larkfield-bakery. No request was made and no code was run.

· A content client is created when the framework's config file loads
    next.config.mjs:3: a content client is created when this config file loads.

1 to look at, none to fix first.
```

## What they do not cover

- `webhook-purges-draft-ids` does not read the webhook's own settings in Sanity, and does not follow a clear made in a helper another file defines.
- `cms-client-in-framework-config` follows one local import, not a chain of them, and does not know a content system whose client is not made by one of the calls it looks for.
- Neither check says what Sanity or the framework does; both are about the shape of the code.

## When it cannot check

If the folder holds no source file, or a source file was left out (too large, not readable, a link), the checks say they could not check, with that reason, and never that they passed. A folder with more files than Gaugeline reads never passes either.

[Every check, with what it catches and how to fix it](/docs/checks)

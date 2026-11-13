# The publish webhook and the cache, read from your code

When an editor publishes in Sanity, a webhook tells your Next.js site to clear what it cached. Two
things in that chain break quietly and are visible only in the code: what the receiver answers when
its secret is not set, and whether the Sanity client reads through a cache that can hand back the
copy from before the publish. These checks read your repository, not the live site, so they work
before the site is deployed: on a build for a pop-up bar, a clinic or a shop, before it goes live.

They belong to the static checks, which read a folder of source and make no request. They only read.
Gaugeline never runs your code, never opens a `.env` file or a key file, and never prints what it finds
in a file: a finding names the file and the line, and says what is wrong in Gaugeline's own words.

## A missing webhook secret answered with the wrong status

`webhook-missing-secret-status` (fix first) finds the code that receives the publish webhook (a file
that imports `@sanity/webhook` or `next-sanity/webhook`, reads the `sanity-webhook-signature` header,
or is a route that revalidates behind a secret) and reads what it answers when the secret is not set
in the environment.

- A 5xx, or a thrown error, passes: a missing secret is the site's fault, not the request's.
- A 4xx is a finding: the sender is told the request was wrong, and senders generally treat that as a
  delivery that will not succeed on a retry. Gaugeline has not confirmed Sanity's own retry rules from
  its documentation, so treat that as the usual rule, not Sanity's promise.
- A 200 is a finding: with no secret, every request is accepted.
- `parseBody` from `next-sanity/webhook` returns `null` for `isValidSignature` when no secret is passed,
  so a test written as `isValidSignature === false` lets that request through. Test
  `isValidSignature !== true`.

A receiver with no branch for a missing secret, or one that reads no secret from `process.env`, is
reported as could not check: Gaugeline cannot tell what it answers, and it does not call that a pass.

Harbor Lane Taproom is an invented bar. Its site clears the cached events and menu when the owner
publishes, and its receiver answers 401 when the secret is not set.

<!-- source-fixture: webhook-missing-secret-status/fail -->

```sh title=Terminal untested="The command that runs the static checks on a folder arrives with the indexing checks. packages/cli/src/__tests__/source-webhook-docs.test.ts runs the same checks on the same invented folder (packages/fixtures/source/webhook-missing-secret-status/fail) and compares the Output block with what the CLI's own terminal report prints."
$ npx gaugeline source ./harbor-lane-taproom
```

```sh title=Output
✗ A missing webhook secret is answered with the wrong status
    app/api/revalidate/route.ts:7: a missing webhook secret is answered with 401.

1 to look at, 1 to fix first.
```

The fix is one branch, before the signature is read:

```ts
const secret = process.env.SANITY_REVALIDATE_SECRET;
if (!secret) {
  return new Response("The webhook secret is not set.", { status: 500 });
}
```

## The Sanity client reads through the CDN, and the reads are cached by tag

`sanity-cdn-tagged-reads` (fix first) finds a Sanity client created with `useCdn: true` in a site that
caches reads by tag (a `next: { tags }` option on a fetch, or a call to `revalidateTag`).
`useCdn: true` reads through Sanity's edge cache, which the client's documentation says to switch off
to bypass it. A site that clears a tag on publish and then reads again can be handed the copy from
before the publish, and then keep it until the next revalidation.

Set `useCdn: false` on the client that reads published content for pages cached by tag. Keep `true`
for reads that are not cached by tag and do not need to show a publish at once, such as a search box.

A `useCdn` that is set from an expression, a client with no `useCdn` and options that are not written
in the call are reported as could not check: Gaugeline has not confirmed what the client does when
`useCdn` is not set, so it does not guess.

<!-- source-fixture: sanity-cdn-tagged-reads/fail -->

```sh title=Terminal untested="The command that runs the static checks on a folder arrives with the indexing checks. packages/cli/src/__tests__/source-webhook-docs.test.ts runs the same checks on the same invented folder (packages/fixtures/source/sanity-cdn-tagged-reads/fail) and compares the Output block with what the CLI's own terminal report prints."
$ npx gaugeline source ./harbor-lane-taproom
```

```sh title=Output
✗ The Sanity client reads through the CDN, and the reads are cached by tag
    lib/sanity/client.ts:8: useCdn is true, and reads are cached by tag (app/events/page.tsx).

1 to look at, 1 to fix first.
```

## What could not be checked

A code file that was too large to read, or could not be read, makes both checks report could not
check when they found nothing: what was left out may hold the pattern. A folder with no webhook
receiver, and no Sanity client, passes: there is nothing to look at.

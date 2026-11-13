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

```sh title=Terminal untested="The docs runner points every example at a fixture website, and this command reads a folder. packages/cli/src/__tests__/source-webhook-docs.test.ts runs the same command on the same invented folder (packages/fixtures/source/webhook-missing-secret-status/fail) and compares the Output block with what it prints."
$ npx gaugeline source ./harbor-lane-taproom
```

```sh title=Output
Read 1 file in ./harbor-lane-taproom. No request was made and no code was run.

✗ A missing webhook secret is answered with the wrong status
    app/api/revalidate/route.ts:8: a missing webhook secret is answered with 401.
· The webhook signature is compared with a plain comparison
    app/api/revalidate/route.ts:14: this receiver uses the official verification helper, which compares signatures with a plain comparison (read in @sanity/webhook 4.0.4). Advice, not a failure.
· The webhook's signed timestamp has no age limit
    app/api/revalidate/route.ts:14: this receiver uses the official verification helper, which makes no age check (read in @sanity/webhook 4.0.4). Advice, not a failure.

3 to look at, 1 to fix first.
```

The two lines marked with a dot are advice from the checks further down this page: the receiver uses
`next-sanity`'s `parseBody`, which is built on the official helper. They are not failures.

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

```sh title=Terminal untested="The docs runner points every example at a fixture website, and this command reads a folder. packages/cli/src/__tests__/source-webhook-docs.test.ts runs the same command on the same invented folder (packages/fixtures/source/sanity-cdn-tagged-reads/fail) and compares the Output block with what it prints."
$ npx gaugeline source ./harbor-lane-taproom
```

```sh title=Output
Read 2 files in ./harbor-lane-taproom. No request was made and no code was run.

✗ The Sanity client reads through the CDN, and the reads are cached by tag
    lib/sanity/client.ts:8: useCdn is true, and reads are cached by tag (app/events/page.tsx).

1 to look at, 1 to fix first.
```

## The signature compared with a plain comparison

`webhook-signature-compared-plainly` (fix soon) finds a receiver that compares the signature, or a
shared secret, with `===`, `!==`, `==` or `!=`. A plain comparison stops at the first character that
differs, so how long it takes can tell a caller how much of a guess was right. Compare with
`crypto.timingSafeEqual` on two Buffers, after checking that their lengths are equal (it throws when
they differ).

The official `@sanity/webhook` helper, read in its source at 4.0.4, compares with a plain `!==`
itself. A receiver that uses the helper is not failed for it: it gets a "worth knowing" finding that
says so.

Bluebell Clinic is an invented clinic whose site shows its opening hours from Sanity.

<!-- source-fixture: webhook-signature-compared-plainly/fail -->

```sh title=Terminal untested="The docs runner points every example at a fixture website, and this command reads a folder. packages/cli/src/__tests__/source-webhook-docs.test.ts runs the same command on the same invented folder (packages/fixtures/source/webhook-signature-compared-plainly/fail) and compares the Output block with what it prints."
$ npx gaugeline source ./bluebell-clinic
```

```sh title=Output
Read 1 file in ./bluebell-clinic. No request was made and no code was run.

! The webhook signature is compared with a plain comparison
    app/api/revalidate/route.ts:20: the signature is compared with a plain comparison.

1 to look at, none to fix first.
```

## The signed timestamp with no age limit

`webhook-timestamp-unbounded` (fix soon) finds a receiver that reads the signed timestamp (the `t`
in the `sanity-webhook-signature` header) and does not reject one that is old or one that is in the
future. The signature covers the timestamp, but a request that was captured once stays valid for as
long as nothing compares the timestamp with the time now.

Read `t` from the header and reject the request when `Math.abs(Date.now() - t)` is more than a few
minutes. The official helper makes no age check either (read at 4.0.4), so a receiver that only uses
it gets a "worth knowing" finding, not a failure. A comparison with the time that Gaugeline cannot
read as a limit on the timestamp is reported as could not check.

<!-- source-fixture: webhook-timestamp-unbounded/fail -->

```sh title=Terminal untested="The docs runner points every example at a fixture website, and this command reads a folder. packages/cli/src/__tests__/source-webhook-docs.test.ts runs the same command on the same invented folder (packages/fixtures/source/webhook-timestamp-unbounded/fail) and compares the Output block with what it prints."
$ npx gaugeline source ./bluebell-clinic
```

```sh title=Output
Read 1 file in ./bluebell-clinic. No request was made and no code was run.

! The webhook's signed timestamp has no age limit
    app/api/revalidate/route.ts:17: the signed timestamp is read but never compared with the time now.

1 to look at, none to fix first.
```

## The body parsed before its signature, or read with no size limit

`webhook-body-read-unsafely` (fix soon) finds a receiver that parses the body (`req.json()`, a
`JSON.parse` before the signature step, or Next's parsed `req.body` in a `pages/api` route) before the
signature is checked over the raw body, and one that reads the whole body with no size limit. The
official helper's documentation says to give it the payload straight from the request, not a
re-encoded JSON string.

Check the `Content-Length` header against a limit (64 KB is plenty for a publish), read the body once
with `req.text()`, check the signature over that text, and only then `JSON.parse` it. A size limit
Gaugeline recognises is a `content-length` check, a stream reader, or a `limit` option.

Fennel Lane Bakery is an invented bakery whose menu is published from Sanity.

<!-- source-fixture: webhook-body-read-unsafely/fail -->

```sh title=Terminal untested="The docs runner points every example at a fixture website, and this command reads a folder. packages/cli/src/__tests__/source-webhook-docs.test.ts runs the same command on the same invented folder (packages/fixtures/source/webhook-body-read-unsafely/fail) and compares the Output block with what it prints."
$ npx gaugeline source ./fennel-lane-bakery
```

```sh title=Output
Read 1 file in ./fennel-lane-bakery. No request was made and no code was run.

! The webhook body is parsed before its signature is checked, or read with no size limit
    app/api/revalidate/route.ts:12: the body is parsed with req.json(), so the signature cannot be checked over the raw body.
! The webhook body is parsed before its signature is checked, or read with no size limit
    app/api/revalidate/route.ts:12: the body is read in full with no size limit.

2 to look at, none to fix first.
```

## The body, an id or the secret in a log

`webhook-logs-private-values` (fix soon) reads every `console`, `logger` and `log` call in a receiver
and finds one that includes the request body, a document id, the signature or the secret. A publish
body holds the document's content (a notice, a customer's name in a booking), and a secret in a log
is a secret that has leaked.

The finding names the file and the line, and the kind of thing logged. It never prints what was
logged. Log what happened (the document type, the status you answered with, a count), not what was
received.

Marlowe Street Dental is an invented clinic.

<!-- source-fixture: webhook-logs-private-values/fail -->

```sh title=Terminal untested="The docs runner points every example at a fixture website, and this command reads a folder. packages/cli/src/__tests__/source-webhook-docs.test.ts runs the same command on the same invented folder (packages/fixtures/source/webhook-logs-private-values/fail) and compares the Output block with what it prints."
$ npx gaugeline source ./marlowe-street-dental
```

```sh title=Output
Read 1 file in ./marlowe-street-dental. No request was made and no code was run.

! The webhook receiver writes the body, an id or a secret to its logs
    app/api/revalidate/route.ts:29: a log call includes the request body.
! The webhook receiver writes the body, an id or a secret to its logs
    app/api/revalidate/route.ts:30: a log call includes a document id and the secret.

2 to look at, none to fix first.
```

## A read cached for a time and by a tag

`revalidate-time-and-tag-mixed` (fix soon) finds one read that sets both a `revalidate` time and
`tags` (a fetch's `next` option, or the options of `unstable_cache`), or a file that sets
`export const revalidate` while its own reads use tags. With tags, the content changes when an editor
publishes and your webhook clears the tag. With a time as well, the same read also refreshes on a
timer, so the page can change with no publish, and a missed webhook is hidden until the timer runs
out. Both are documented Next.js options for different jobs; pick one per read.

`revalidate: false` and `revalidate: 0` are not timers and are not reported. A `revalidate` that is not
a number or `false` is reported as could not check.

Blue Heron Pop-Up is an invented pop-up bar that lists its next dates from Sanity.

<!-- source-fixture: revalidate-time-and-tag-mixed/fail -->

```sh title=Terminal untested="The docs runner points every example at a fixture website, and this command reads a folder. packages/cli/src/__tests__/source-webhook-docs.test.ts runs the same command on the same invented folder (packages/fixtures/source/revalidate-time-and-tag-mixed/fail) and compares the Output block with what it prints."
$ npx gaugeline source ./blue-heron-pop-up
```

```sh title=Output
Read 3 files in ./blue-heron-pop-up. No request was made and no code was run.

! A read is cached for a time and by a tag
    lib/events.ts:8: this read sets a revalidate time and tags, so it changes on a timer and on publish.

1 to look at, none to fix first.
```

## What could not be checked

A code file that was too large to read, or could not be read, makes both checks report could not
check when they found nothing: what was left out may hold the pattern. A folder with no webhook
receiver, and no Sanity client, passes: there is nothing to look at.

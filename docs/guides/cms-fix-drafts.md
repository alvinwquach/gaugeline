# Fixes as Sanity drafts: the wrong hours, corrected for an editor to read

A bar's opening hours are wrong on its contact page, and the right hours are a fact you have declared
([Facts that must match everywhere](facts.md)). The page's text lives in Sanity, so the right place for the fix
is a **draft** of that document with the corrected hours. An editor reads it in the Studio, and publishes it or
doesn't. Gaugeline never publishes, and never changes the live page.

This is the Sanity half of [Hosted: applying an approved fix](../hosted/writer.md). It runs in **your own
worker** with **your own Sanity token**, only after a person has approved that one fix in
[the inbox](../hosted/inbox.md). The hosted service never holds a token that can write.

## What one approved fix does

- **One document, one change.** The approval names a document, the field or fields to correct, the new text,
  and the SHA-256 of the text each field holds now. Nothing else is in it, so nothing else can be written.
- **A draft, never the live page.** The writer creates `drafts.<id>`: a copy of the live document with the fix
  in it. It has no request that changes the live document, publishes, unpublishes or removes anything.
- **It never overwrites an editor.** If a draft of that document already exists, the writer leaves it alone.
  (Sanity refuses to create a document under an id that is taken.) If that draft already holds exactly the
  approved text, the job is a replay and is recorded as done.
- **It refuses a stale fix.** Just before it writes, it reads the live field and compares it with the digest in
  the approval. If someone edited the field since the fix was proposed, the job is refused and the finding
  stays open for the next run.
- **It never proposes a price.** A field whose name is a price, a cost, a fee, a currency, a discount, a
  payment, a slug, a password or a secret is refused even if you allow it. Prices are for a person.
- **Dry run first.** A worker's setting is `dry-run` unless it says exactly `write`. A dry run sends nothing,
  not even a read, and records the three requests it would make.

After the editor publishes, the next scheduled check reads the page again and the finding closes, as it does for
any fixed problem.

## What you set up

1. A Sanity API token for the one project, kept in the worker's environment. It needs to create documents in
   the one dataset. Pick the narrowest role your Sanity plan offers for that; whether a token can be limited to
   drafts is a Sanity setting that we could not read from here, so check it in your project's API settings. The
   writer sends the token in the `Authorization` header to `<project>.api.sanity.io` only, and refuses
   redirects.
2. The site's target in the worker's configuration. **`allowedFields` is required**: with none, every field is
   refused.

```ts
const target = {
  orgId: "0a000000-0000-4000-8000-00000000000a",
  siteId: "5e000000-0000-4000-8000-0000000000e5",
  projectId: "tidewtr1", // your Sanity project id: its host is tidewtr1.api.sanity.io
  dataset: "production",
  apiVersion: "v2025-02-19",
  allowedFields: ["page.hours", "page.phone"], // "<document type>.<field>", no wildcards
};
```

## Try it on your machine, with no account

This runs the whole path against a local stand-in for Sanity. It needs no project, no token and no network. The
stand-in answers in the shapes Sanity's client documents, and refuses any request the writer's registry would
refuse.

```sh
pnpm exec tsx packages/writer/examples/cms-fix-drafts.ts
```

This is the real output:

```text
1. Dry run (the default): nothing is sent
{
  "draftId": "a1d10000-0000-4000-8000-0000000000a1",
  "decisionId": "42",
  "outcome": "dry_run",
  "planned": [
    {
      "endpoint": "getDoc",
      "path": "/v2025-02-19/data/doc/production/contact-page"
    },
    {
      "endpoint": "getDoc",
      "path": "/v2025-02-19/data/doc/production/drafts.contact-page"
    },
    {
      "endpoint": "mutate",
      "path": "/v2025-02-19/data/mutate/production"
    }
  ]
}
   requests sent: 0
2. Write: one draft is created
{
  "draftId": "a1d10000-0000-4000-8000-0000000000a1",
  "decisionId": "42",
  "outcome": "applied",
  "ref": "drafts.contact-page"
}
   requests sent: getDoc, getDoc, mutate
   the draft: {"title":"Find The Tidewater Bar","hours":"Mon to Sun, 4pm to 11pm","phone":"+44 20 7946 0000","_id":"drafts.contact-page","_type":"page"}
   the live page: {"_id":"contact-page","_type":"page","_rev":"r1","title":"Find The Tidewater Bar","hours":"Mon to Sat, 4pm to 11pm","phone":"+44 20 7946 0000"}
3. The same approval again: no second write
{
  "draftId": "a1d10000-0000-4000-8000-0000000000a1",
  "decisionId": "42",
  "outcome": "applied",
  "ref": "drafts.contact-page"
}
   writes sent: 0
4. Someone edited the hours meanwhile: refused
{
  "draftId": "a1d10000-0000-4000-8000-0000000000a1",
  "decisionId": "42",
  "outcome": "refused",
  "reason": "stale"
}
   writes sent: 0
```

Read it from the top. The dry run sent nothing. The write made three requests, two reads and one create, and
the draft holds the new hours while the live page is untouched. The same approval run again created nothing.
And when the hours were edited meanwhile, the job was refused as `stale` and wrote nothing.

## What it refuses

Each of these ends the job with a `refused` entry in the trail and no write. The reason is the word in code.

| Reason                                                                     | When                                                                                                                                                                             |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `approval`, `draft`, `org`, `site`, `kind`, `hash`, `withdrawn`, `expired` | The approval row is missing, is another job's, was changed after approval, was withdrawn or is over 72 hours old (the same checks as a pull request)                             |
| `payload`                                                                  | The payload is not exactly a document id, a type, the new values and their digests; or the document id is not a plain name (a `drafts.` id, a `..`, an encoded or slash segment) |
| `field`                                                                    | A field is not in `allowedFields` for that document type, or is a price, secret or slug field                                                                                    |
| `missing`, `type`                                                          | The live document is gone, or is not of the approved type                                                                                                                        |
| `stale`                                                                    | A field's live text no longer matches the digest in the approval                                                                                                                 |
| `draft exists`                                                             | A draft of the document is there and does not hold the approved text                                                                                                             |
| `document`                                                                 | The live document is too large to copy (500,000 characters of JSON)                                                                                                              |
| `kill switch`, `organisation paused`                                       | `GAUGELINE_WRITER_STOP` is set, or the organisation paused applying; checked before every request                                                                                |

A request that Sanity itself refuses (a bad token, a conflict because an editor created a draft a moment
earlier) is recorded as `apply_failed` with the HTTP status and nothing from the response.

## What is not here

This page is the writer. The agent that notices the wrong hours and proposes the fix, the inbox screen that
shows the live value next to the proposed one and the fact it came from, and the approval itself, are part of
[the inbox](../hosted/inbox.md). The writer never reads the text of a response into a log, a finding or a
report, and a Sanity token never appears in any of them.

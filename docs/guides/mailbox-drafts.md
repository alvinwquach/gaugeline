# Drafts in your own mailbox: Gmail

The weekly note to a client should come from the person who owns the relationship, in their own words if they
want to change them. So Gaugeline does not send it. After you approve a note in [the inbox](../hosted/inbox.md),
your own worker saves it as a **draft in your own Gmail**, addressed to the client's contacts. You open Drafts,
read it, change it if you like and press Send. Pressing Send is the approval, and it happens in your mail
program, not in Gaugeline.

This is the `email` kind of the [writer](../hosted/writer.md) (ADR-0010). It is Gmail only for now; Outlook is
later. The weekly client update that the hosted app sends from the agency's name is a different path (see
[agencies](../hosted/agencies.md)); it is never saved as a draft here.

## An example: the bar's weekly note

Northgate Studio looks after The Tidewater Bar's site. Maya runs the bar and wants her note from Sam, not from a
service. Northgate's worker is set up with the bar's two contacts, `maya@` and `owner@`
`tidewater-bar.example`. The approved note is a subject and a body, and nothing else: the writer never takes a
recipient from the note.

Dry run first, which is the default. It builds the message, checks it and sends nothing. This is the real output
of `applyEmailDraft` in dry-run mode:

```json
{
  "draftId": "a1d10000-0000-4000-8000-0000000000a1",
  "decisionId": "42",
  "outcome": "dry_run",
  "planned": [
    {
      "endpoint": "createDraft",
      "path": "/gmail/v1/users/me/drafts"
    }
  ]
}
```

With `mode: "write"` the same job makes one request, `POST /gmail/v1/users/me/drafts`. Run against the local
stand-in mailbox that the tests use (it implements `users.drafts.create` and nothing else), this is the real
trail entry, the draft the mailbox then holds, and every other request it saw (none):

```json
{
  "entry": {
    "draftId": "a1d10000-0000-4000-8000-0000000000a1",
    "decisionId": "42",
    "outcome": "applied",
    "ref": "r1000"
  },
  "draft": {
    "to": ["maya@tidewater-bar.example", "owner@tidewater-bar.example"],
    "subject": "Tidewater Bar: this week on your website",
    "text": "Hi Maya,\r\n\r\nThis week we fixed the broken drinks link on the menu page.\r\n\r\nThe finding: https://reports.northgate-studio.example/tidewater-bar/f/3\r\n\r\nSam"
  },
  "otherRequests": []
}
```

The `ref` is Gmail's draft id. The trail records that and the status of a failure; it never records the subject,
the body, an address, the token or anything Gmail answers.

The worker builds its deps like this (the stand-in for tests replaces `fetch`; in your worker it is Gmail):

```ts
const target = {
  orgId: "0a000000-0000-4000-8000-00000000000a",
  siteId: "5e000000-0000-4000-8000-0000000000e5",
  contacts: ["maya@tidewater-bar.example", "owner@tidewater-bar.example"], // the only recipients
  bounced: [], // contacts that bounced last time are left off the draft
};
const deps = {
  target,
  createDraft: gmailSender(
    tokenFromStore(workerSecrets, target.orgId, "gmail-northgate"),
    target.contacts,
  ),
  trail,
  approvals,
  mode: "dry-run", // only the exact word "write" creates a draft
  env: process.env,
  orgPaused,
};
await emailDraftWriter(deps).apply(job);
```

## What you grant: one scope, and where the token lives

Connect the mailbox with the OAuth scope `https://www.googleapis.com/auth/gmail.drafts.create` ("Compose new
draft emails") and no other. It can create a draft. It cannot read your mail and it cannot send: Gmail's method
that sends a draft does not accept it. The wider `gmail.compose` scope would also let the code send, so the
writer does not ask for it, and a test fails if any file in the Gmail code (`packages/writer/src/gmail/`) names it
or another Gmail scope.

Gaugeline never asks to read or send from a personal mailbox.

**The access token is an environment variable on your worker**, `GAUGELINE_GMAIL_ACCESS_TOKEN` by default
(`tokenFromEnv(name)` reads any other capitalised name). It is a write credential, so it is separate from every
read-only key, and the hosted service never holds it (ADR-0010). The writer reads it at each request, from the running worker's own environment (a change made outside the
process needs a restart: see [If the token stops working](#if-the-token-stops-working)), checks its
shape (visible characters, no space, at most 4096) and sends it nowhere but the `Authorization` header. A missing
or malformed token is one fixed error, and the value is never in it. There is no refresh flow: when the token
expires or is revoked, Gmail answers 401 and you reconnect (below). A source behind the same `TokenSource`
interface (for example a secret store, `tokenFromStore`) may replace it, but the environment variable is the v1
way: the hosted secret store has no Gmail secret kind yet.

## What the writer checks first

The same checks as every writer kind ([the full list](../hosted/writer.md#what-the-writer-checks-before-it-writes)):
the stops are off, an approval row exists and is this job's, the payload hashes to the approved hash (it covers
the subject and the body), nothing withdrew it, and it is under 72 hours old. Then, for a draft:

- The note is a subject and a body and nothing else. A `to`, `cc` or `bcc` in it is refused.
- The recipients are the contacts you configured, minus any that bounced. A contact that is not a plain address
  (a display name, a comma, a line break) refuses the job. If none is left, the job is refused.
- A line break, a control character, an invisible character (zero-width, joiners, the byte order mark, soft
  hyphen, tag characters) or a bidirectional control in the subject is refused, not escaped: you approve text you
  can see. The recipients must fit one header line (900 characters joined). The body
  is plain text: each line is cleaned of terminal escapes, tag characters and bidirectional controls, and zero-width
  characters inside a word are shown as `\u{200B}`.
- The message is built by one small function (RFC 5322 headers, an RFC 2047 subject when it is not plain ASCII,
  an RFC 2045 base64 body). The same input gives the same bytes. It has no Date, no Message-ID and no From:
  Gmail fills them in when you open the draft.
- The request is then read back: it must be exactly `POST /gmail/v1/users/me/drafts` with `{ message: { raw } }`,
  and every recipient in the message must be one of your contacts. Anything else is refused before the token is
  read.

## One approval, one draft

A second apply of the same approval is refused as `duplicate`, whether it is the same process, a record that
already says `applied`, or two calls at once. Gmail has no idempotency key and the scope cannot list drafts.

- If Gmail answers 200 and then the trail entry cannot be written, the draft exists. The writer never records
  `apply_failed` for it, keeps the decision claimed (a retry is refused as `duplicate`) and throws a
  `DraftCreatedError` whose message is fixed and whose `ref` is Gmail's draft id. To reconcile, record the
  `applied` entry for that decision yourself with that `ref` **before restarting the worker**: the claim lives
  in the process, and after a restart only an `applied` entry stops a second draft. If you cannot, look in Drafts
  and delete the duplicate; nothing here can send it.
- If the network drops before Gmail answers, nobody knows whether the draft exists: the entry is `apply_failed`
  with no status, and a retry can leave one extra draft in Drafts. You delete it.

## If the token stops working

- Gmail answers 401 or 403 (revoked, expired, scope removed): the entry is `apply_failed` with that status and the
  reason `reconnect`. The draft stays in the inbox, with a note to reconnect the mailbox.
- You disconnect the mailbox: you remove the token. **Unsetting the environment variable only takes effect after
  the worker restarts.** `tokenFromEnv` (`packages/writer/src/gmail/send.ts`) reads `process.env` of the running
  worker each time `gmailSender` makes a request, but a running process does not see a change made to its
  environment from outside: the value it started with stays in `process.env`. Unset the variable in your worker's
  configuration and restart the worker; until it has restarted, an approved note is still saved with the old
  token. After the restart the next draft is refused as `disconnected` and no request is made. If you cannot
  restart yet, revoke the token in your Google account: Gmail then answers 401 and the entry is `apply_failed`
  with the reason `reconnect` (above). A token kept in a store behind `tokenFromStore` is read from the store at
  each request, so deleting it there takes effect at once and needs no restart.
- The token is sent in the `Authorization` header to `gmail.googleapis.com` only, over https, with redirects
  refused. It is never in a log, a trail entry, an error or a request address.

## What it never does

It never sends (no send request exists in the registry, and a test asserts that), never reads or lists mail,
never edits or deletes a draft, and never writes without an approval row. Replying to an email does not approve
anything: replies are too easy to forge.

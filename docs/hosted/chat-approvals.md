# Hosted: approving in Slack, Discord and Teams

The hosted version of Gaugeline (in progress, not released) will let a team approve or decline a
proposed fix with one button in the chat where they already talk. A draft waiting in an inbox nobody
opens is the same as no draft. This is **part 1 of 3**: the checks a chat request must pass and the
decision it records. The Slack message with its buttons is part 2; Discord and Teams are part 3. Nothing
in this part sends a message or listens on an address yet.

The rule that does not change: **a chat click can do only what the same person could do in the
[inbox](./inbox.md).** It writes the same append-only decision row the inbox writes, through the same code,
and it never applies anything: after an approval your own worker applies the draft with your own
credentials, as before ([applying an approved fix](./writer.md), ADR-0010).

## An example: the bar's menu link, approved from `#tidewater`

The Tidewater Bar's menu links to a page that no longer exists, and an agent drafted a fix. Northgate
Studio's developer sees it in `#tidewater` with an Approve button. She presses it. Slack sends the hosted
app a request. Before the app reads a word of it, it checks the request was signed by Northgate's own
Slack app. This is `slackVerifier` from `apps/hosted/chat/verify.ts`, run with
`node --import tsx example.mts` in `apps/hosted`, with an invented signing secret and a fixed clock:

```ts
import { createHmac } from "node:crypto";
import { slackVerifier } from "./chat/verify.js";

const secret = "northgate-example-signing-secret";
const now = new Date("2026-11-13T09:00:00Z");
const ts = Math.floor(now.getTime() / 1000);
const body =
  "payload=" +
  encodeURIComponent(JSON.stringify({ type: "block_actions", user: { id: "U0MEMBER" } }));
const sign = (b: string, t: number) =>
  "v0=" + createHmac("sha256", secret).update(`v0:${t}:${b}`).digest("hex");
const check = (label: string, b: string, t: number, signature: string) => {
  const headers = new Headers({
    "x-slack-signature": signature,
    "x-slack-request-timestamp": String(t),
  });
  const r = slackVerifier({ secret, rawBody: Buffer.from(b), headers, now });
  console.log(
    label.padEnd(26),
    r.ok ? "accepted, key " + r.requestKey.slice(0, 12) + "..." : "refused: " + r.reason,
  );
};

check("signed by the workspace", body, ts, sign(body, ts));
check("body changed by one byte", body + "x", ts, sign(body, ts));
check("six minutes old", body, ts - 360, sign(body, ts - 360));
check("signed with another secret", body, ts, "v0=" + "ab".repeat(32));
```

```text
signed by the workspace    accepted, key c427b2e9661c...
body changed by one byte   refused: bad-signature
six minutes old            refused: stale
signed with another secret refused: bad-signature
```

Only the first goes on. The same signed request sent a second time is refused as a replay, because its
key (the signature) was recorded the first time.

## What a request must pass, in this order

A request stops at the first check it fails, and nothing later runs. The five answer `401` with the same
body, so a caller cannot tell which one it hit; the server's log gets a short reason code (never a
secret, a signature or a body).

1. **Size.** The body is read up to 64 KB. A larger one, or one that sends more than it said it would,
   is refused (`413`) without being read to the end.
2. **Connection.** The address names one connection by its id
   (`/chat/<provider>/<connection id>`, arriving with part 2). An unknown or switched-off connection, or
   one for another provider, is refused. The id names a row; it is not a credential.
3. **Secret.** The connection's signing secret is read from the secret store, never from anything the
   request says. A connection whose secret is not a signing secret has none.
4. **Signature.** The signature is checked over the **raw bytes**, before anything is parsed, with a
   constant-time comparison, and the timestamp must be within five minutes of the server's clock, past or
   future.
5. **Replay.** The request's key is recorded once. A second request with the same key is refused. This
   comes after the signature on purpose: someone who knew a connection's id could otherwise use up keys
   with forged requests, and the real request would then be refused as a replay. A test shows a forgery
   does not use up its key.

Slack's scheme is HMAC-SHA256 of `v0:<timestamp>:<raw body>` under the app's signing secret, with a
five-minute window. Slack's own reference code refuses only an old timestamp; this also refuses one from
the future. Discord uses an Ed25519 signature and Teams a bearer token or an HMAC; those arrive with part 3.

## Who the click is

A chat user id is not a person until a link says so, and a link needs two people. An **owner or admin
proposes it** (`chat_identities`, one row per connection and chat user), and then **that member, signed in,
confirms it**. Only the member can set the confirmation, and the database stamps it. Until then the link
counts for nothing: without the second step an admin could link any chat user to the owner and record
decisions in the owner's name. A member can remove their own link; an admin can remove any.

When a press arrives, `private.chat_decide` runs these in order, each one refusing before anything is
written:

1. The payload names the workspace the connection was made for (a Slack team id), when one was set.
2. The chat user has a **confirmed** link. A stranger, or a user whose link nobody confirmed, gets a
   private reply that says so, and nothing is recorded.
3. The member is staff: owner, admin or member. A **client viewer** who was linked and confirmed still
   cannot decide, and nothing is recorded. A member who leaves the organisation takes their links with them.
4. The draft belongs to **this connection's organisation**. A person who works for two agencies cannot
   decide one agency's draft through the other's chat.
5. A draft that is already decided answers with who decided first, whether the first decision came from
   chat, the inbox, or the other press of a double click. Two presses at the same moment give one decision
   and one apply job.
6. An approval of a proposal older than **72 hours** is refused (a decline is not). ADR-0010 proposes
   72 hours; it is the owner's number, not a vendor's.
7. The draft's findings are its own site's, and none of them has closed since it was written. These are
   the inbox's own checks, written once in SQL (`private.own_findings`, `private.closed_findings`) and
   called by both the inbox and chat. The inbox asks for a second, deliberate click when a finding has
   closed; chat does not offer that click and sends the person to the inbox.

Then it writes the one decision row the inbox would write, as that member, and returns what the apply
queue needs; the endpoint enqueues it in the same transaction. The payload's shape and its SHA-256 are
checked by the triggers of migration 0005, whoever writes the row.

**The deciding happens in the database, and the caller never names the member.** The chat login supplies
only what the signed request said (the connection, the chat user id, the draft, approve or decline).
It is not a member of `authenticated`, so it cannot set someone's claims and write a decision in their
name, and it cannot read a draft, a decision or a link. The most a compromised chat endpoint can do is
what a confirmed, allowed member's own press could do, for a connection whose id it knows.

## What the chat endpoint can reach

It runs on its own database login: a member of `gaugeline_chat` **and nothing else**. `gaugeline_chat`
holds no privilege on any table and may call four functions, each of which takes the connection id from
the address and nothing from the request body. This is `psql` 16 against the test database
(`apps/hosted/db/migrations/0010_chat_approvals.sql`), with the two invented organisations from the data
model page and a draft waiting in the inbox; the first blocks are set-up. The session is a superuser's
(`set role` stands in for the chat login), so what a real login cannot do is shown by the tests, not by
this output.

```sql
-- a draft waiting in the inbox, as the agent would have written it
insert into public.drafts (id, org_id, site_id, kind, payload)
  values ('a1d10000-0000-4000-8000-0000000000a2', '0a000000-0000-4000-8000-00000000000a',
          'a1000000-0000-4000-8000-0000000000a1', 'email',
          '{"subject":"Your menu link is fixed","body":"The drinks page is back."}');

-- set-up, as the schema owner: the settings API stores the Slack app's signing secret (Vault) and the
-- connection that names it; an admin proposes two links; the member confirms theirs, signed in
set role service_role;
select private.put_secret($1, $2, $3, $4)
\bind '0a000000-0000-4000-8000-00000000000a' 'chat-slack' 'signing_secret' 'northgate-example-signing-secret' \g
insert into public.chat_connections (id, org_id, provider, label, workspace_ref, secret_name)
  values ('c1000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', 'slack',
          'Northgate Slack', 'T0NORTHGATE', 'chat-slack');
insert into public.chat_identities (org_id, connection_id, chat_user_id, user_id)
  values ('0a000000-0000-4000-8000-00000000000a', 'c1000000-0000-4000-8000-0000000000a1', 'U0MEMBER',
          '11111111-0000-4000-8000-000000000002'),
         ('0a000000-0000-4000-8000-00000000000a', 'c1000000-0000-4000-8000-0000000000a1', 'U0OWNER',
          '11111111-0000-4000-8000-000000000001');
reset role;
select set_config('request.jwt.claims', '{"sub":"11111111-0000-4000-8000-000000000002"}', false) \g /dev/null
set role authenticated;
update public.chat_identities set confirmed_at = now() where chat_user_id = 'U0MEMBER';
reset role;

-- the chat endpoint's role: four functions, no table
set role gaugeline_chat;
select private.chat_signing_secret('c1000000-0000-4000-8000-0000000000a1') is not null as has_secret;
select private.chat_claim_request('c1000000-0000-4000-8000-0000000000a1', 'c427b2e9661c0000') as first_time;
select private.chat_claim_request('c1000000-0000-4000-8000-0000000000a1', 'c427b2e9661c0000') as second_time;
-- the owner's link was proposed, not confirmed: pressing as U0OWNER decides nothing
select r_status from private.chat_decide('c1000000-0000-4000-8000-0000000000a1', 'U0OWNER', 'a1d10000-0000-4000-8000-0000000000a2', 'approve');
select r_status from private.chat_decide('c1000000-0000-4000-8000-0000000000a1', 'U0STRANGER', 'a1d10000-0000-4000-8000-0000000000a2', 'approve');
select r_status, r_decision from private.chat_decide('c1000000-0000-4000-8000-0000000000a1', 'U0MEMBER', 'a1d10000-0000-4000-8000-0000000000a2', 'approve');
select * from public.drafts;
reset role;
select decision, decided_by from public.decisions where draft_id = 'a1d10000-0000-4000-8000-0000000000a2';
```

```text
INSERT 0 1
SET
 put_secret
------------
 created
(1 row)

INSERT 0 1
INSERT 0 2
RESET
SET
UPDATE 1
RESET
SET
 has_secret
------------
 t
(1 row)

 first_time
------------
 t
(1 row)

 second_time
-------------
 f
(1 row)

   r_status
--------------
 unknown-user
(1 row)

   r_status
--------------
 unknown-user
(1 row)

 r_status | r_decision
----------+------------
 recorded | approved
(1 row)

ERROR:  permission denied for table drafts
RESET
 decision |              decided_by
----------+--------------------------------------
 approved | 11111111-0000-4000-8000-000000000002
(1 row)
```

`private.chat_signing_secret` returns a value only for an active connection whose secret is of kind
`signing_secret`; a webhook URL is not handed out through it. Deleting the secret deletes the connection.
`apps/hosted/db/audit.ts` has `chatLoginsWithOtherRoles`, which must return `[]`: a login that is a member
of `gaugeline_chat` and also of `authenticated`, `anon`, `service_role`, `gaugeline_worker` or
`gaugeline_agent` is not limited to this. Tests run as the real login: setting someone's claims and
`set role authenticated` is refused, and so is every other role.

Used-up request keys are kept for a day and then removed by the next claim. The timestamp window refuses
an older request before the table is asked. Keys are compared in lowercase, so a copy of an accepted
signature in capitals is the same request.

## Who can see and change what

| Who                         | Connections                    | Links (chat user to member)                               | Signing secrets |
| --------------------------- | ------------------------------ | --------------------------------------------------------- | --------------- |
| Owner or admin              | Read (name of the secret only) | Read all, propose, remove (their own org); cannot confirm | Never readable  |
| Member, client viewer       | None                           | Read, confirm (once) and remove their own                 | Never readable  |
| The server (`service_role`) | Add, remove, switch off        | Propose, remove                                           | Write-only      |
| The chat endpoint           | One, by id, through a function | None directly; `chat_decide` reads confirmed links        | One, by id      |

## Needs from the owner before launch

- Nothing to create for this part. Each customer will create their own Slack app and give the hosted app
  its signing secret; we create no Slack app. The Slack message and the address arrive with part 2.
- A database login for the chat endpoint that is a member of `gaugeline_chat` **only** (never
  `authenticated`, `service_role` or `gaugeline_worker`): `grant gaugeline_chat to gl_chat_login;` and
  `chatLoginsWithOtherRoles` must return `[]`.

## What is still at risk

A full compromise of the chat endpoint, or its database login, can read the signing secret of any
connection whose id it learns, and can record an approval for any confirmed, allowed member of that
connection's organisation. It cannot record one for a member who never confirmed a link, for a client
viewer, or across organisations, and it cannot apply anything: your own worker re-checks every approval
before it writes. Rotating the signing secret and removing the links closes it. Keeping the secret out of
the endpoint altogether (verifying the signature inside the database) is not done.

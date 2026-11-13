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

A chat user id is not a person until an **owner or admin of the organisation links it** to a member
(`chat_identities`, one row per connection and chat user). Then, in this order, each one refusing before
anything is written:

1. The payload names the workspace the connection was made for (a Slack team id), when one was set.
2. The chat user is linked. A stranger gets a private reply that says so, and nothing is recorded.
3. The member is staff: owner, admin or member. A **client viewer** who was linked still cannot decide, and
   nothing is recorded. A member who leaves the organisation takes their links with them.
4. The draft belongs to **this connection's organisation**. A person who works for two agencies cannot
   decide one agency's draft through the other's chat.
5. A draft that is already decided answers with who decided first, whether the first decision came from
   chat, the inbox, or the other press of a double click. Two presses at the same moment give one decision
   and one apply job.
6. An approval of a proposal older than **72 hours** is refused (a decline is not). ADR-0010 proposes
   72 hours; it is the owner's number, not a vendor's.

If a finding the draft fixes has closed since it was written, the inbox asks for a second, deliberate
click. Chat does not offer that click: the person is sent to the inbox.

The decision is then written as the member, under row-level security, by the same function the inbox uses
(`decide` in `apps/hosted/inbox/inbox.ts`). The chat login cannot write a decision in anyone else's name.

## What the chat endpoint can reach

It runs on its own database login: a member of `authenticated` (to write the decision as the member) and of
`gaugeline_chat`, a role that holds **no privilege on any table**. `gaugeline_chat` may call four
functions, each of which takes the connection id from the address and nothing from the request body.
This is `psql` 16 against the test database (`apps/hosted/db/migrations/0010_chat_approvals.sql`), with the
two invented organisations from the data model page; the first block is set-up as the schema owner.

```sql
-- set-up: the settings API stores the Slack app's signing secret (Vault) and then the connection that
-- names it; an owner links two chat users, one to a member and one to a client viewer
set role service_role;
select private.put_secret($1, $2, $3, $4)
\bind '0a000000-0000-4000-8000-00000000000a' 'chat-slack' 'signing_secret' 'northgate-example-signing-secret' \g
insert into public.chat_connections (id, org_id, provider, label, workspace_ref, secret_name)
  values ('c1000000-0000-4000-8000-0000000000a1', '0a000000-0000-4000-8000-00000000000a', 'slack',
          'Northgate Slack', 'T0NORTHGATE', 'chat-slack');
reset role;
insert into public.chat_identities (org_id, connection_id, chat_user_id, user_id)
  values ('0a000000-0000-4000-8000-00000000000a', 'c1000000-0000-4000-8000-0000000000a1', 'U0MEMBER',
          '11111111-0000-4000-8000-000000000002'),
         ('0a000000-0000-4000-8000-00000000000a', 'c1000000-0000-4000-8000-0000000000a1', 'U0CLIENT',
          '33333333-0000-4000-8000-000000000001');

-- the chat endpoint's role: it can ask four questions and it can read no table
set role gaugeline_chat;
select org_id, provider, workspace_ref from private.chat_connection('c1000000-0000-4000-8000-0000000000a1');
select private.chat_signing_secret('c1000000-0000-4000-8000-0000000000a1') is not null as has_secret;
select user_id, role from private.chat_member('c1000000-0000-4000-8000-0000000000a1', 'U0CLIENT');
select private.chat_claim_request('c1000000-0000-4000-8000-0000000000a1', 'c427b2e9661c0000') as first_time;
select private.chat_claim_request('c1000000-0000-4000-8000-0000000000a1', 'c427b2e9661c0000') as second_time;
select * from public.chat_identities;
select decrypted_secret from vault.decrypted_secrets;
reset role;

-- a signed-in person cannot ask any of them
select set_config('request.jwt.claims', '{"sub":"11111111-0000-4000-8000-000000000001"}', false) \g /dev/null
set role authenticated;
select private.chat_signing_secret('c1000000-0000-4000-8000-0000000000a1');
```

```text
SET
 put_secret
------------
 created
(1 row)

INSERT 0 1
RESET
INSERT 0 2
SET
                org_id                | provider | workspace_ref
--------------------------------------+----------+---------------
 0a000000-0000-4000-8000-00000000000a | slack    | T0NORTHGATE
(1 row)

 has_secret
------------
 t
(1 row)

               user_id                |  role
--------------------------------------+--------
 33333333-0000-4000-8000-000000000001 | client
(1 row)

 first_time
------------
 t
(1 row)

 second_time
-------------
 f
(1 row)

ERROR:  permission denied for table chat_identities
ERROR:  permission denied for schema vault
LINE 1: select decrypted_secret from vault.decrypted_secrets;
                                     ^
RESET
SET
ERROR:  permission denied for function chat_signing_secret
```

`private.chat_signing_secret` returns a value only for an active connection whose secret is of kind
`signing_secret`; a webhook URL is not handed out through it. Deleting the secret deletes the connection.
`apps/hosted/db/audit.ts` has `chatLoginsWithOtherRoles`, which must return `[]`: a login that is a member
of `gaugeline_chat` and also of `service_role`, `gaugeline_worker` or `gaugeline_agent` is not limited to
this.

Used-up request keys are kept for a day and then removed by the next claim. The timestamp window refuses
an older request before the table is asked.

## Who can see and change what

| Who                         | Connections                    | Links (chat user to member)       | Signing secrets |
| --------------------------- | ------------------------------ | --------------------------------- | --------------- |
| Owner or admin              | Read (name of the secret only) | Read, add, remove (their own org) | Never readable  |
| Member, client viewer       | None                           | None                              | Never readable  |
| The server (`service_role`) | Add, remove, switch off        | Add, remove                       | Write-only      |
| The chat endpoint           | One, by id, through a function | One, through a function           | One, by id      |

## Needs from the owner before launch

- Nothing to create for this part. Each customer will create their own Slack app and give the hosted app
  its signing secret; we create no Slack app. The Slack message and the address arrive with part 2.
- A database login for the chat endpoint that is a member of `gaugeline_chat` and `authenticated` only
  (never `service_role` or `gaugeline_worker`): `grant gaugeline_chat, authenticated to gl_chat_login;`
  and `chatLoginsWithOtherRoles` must return `[]`.

# Hosted: approval receipts

The hosted version of Gaugeline (in progress, not released) writes a **receipt** every time a person
approves, edits and approves, or declines a draft in the inbox. Receipts form one hash chain per
organisation, which owners and admins download and check on their own computer with
[`gaugeline receipts verify`](../guides/verify-receipts.md): no network, no key.

## An example: a studio and a pop-up bar

Lantern Studio looks after The Night Market Bar's site. The inbox holds two email drafts for the bar: one
saying its opening hours are fixed, and the weekly update. The studio's owner approves the first; its admin
declines the second. Each choice writes its receipt in the same transaction. This is the test database
(`apps/hosted/db/__tests__/harness.ts`, the migrations applied, nothing else), with the times written out so
the example does not change; in the app the database sets them:

```sql title="example.sql"
-- An invented studio, its owner and admin, a pop-up bar's site, two drafts.
insert into public.organisations (org_id, name) values ('6a1f0000-0000-4000-8000-00000000c0de', 'Lantern Studio');
insert into public.sites (id, org_id, name, url) values
  ('5e1e0000-0000-4000-8000-000000000001', '6a1f0000-0000-4000-8000-00000000c0de', 'The Night Market Bar', 'https://night-market-bar.test');
insert into public.members (org_id, user_id, role) values
  ('6a1f0000-0000-4000-8000-00000000c0de', '7b2e0000-0000-4000-8000-000000000001', 'owner'),
  ('6a1f0000-0000-4000-8000-00000000c0de', '7b2e0000-0000-4000-8000-000000000002', 'admin');
insert into public.drafts (id, org_id, site_id, kind, payload) values
  ('8c3d0000-0000-4000-8000-000000000001', '6a1f0000-0000-4000-8000-00000000c0de', '5e1e0000-0000-4000-8000-000000000001',
   'email', '{"subject": "Your opening hours are fixed", "body": "Thursday to Saturday, 5pm to 11pm."}'),
  ('8c3d0000-0000-4000-8000-000000000002', '6a1f0000-0000-4000-8000-00000000c0de', '5e1e0000-0000-4000-8000-000000000001',
   'email', '{"subject": "Weekly update", "body": "Nothing broke this week."}');
-- The owner approves the first; the admin declines the second. Each insert writes its receipt.
insert into public.decisions (org_id, draft_id, decision, decided_by, decided_at) values
  ('6a1f0000-0000-4000-8000-00000000c0de', '8c3d0000-0000-4000-8000-000000000001', 'approved',
   '7b2e0000-0000-4000-8000-000000000001', '2026-11-12T09:30:00.125Z');
insert into public.decisions (org_id, draft_id, decision, decided_by, decided_at) values
  ('6a1f0000-0000-4000-8000-00000000c0de', '8c3d0000-0000-4000-8000-000000000002', 'declined',
   '7b2e0000-0000-4000-8000-000000000002', '2026-11-12T09:31:10.5Z');
```

The owner downloads the chain from `GET /receipts` (the organisation they have chosen in the app):

```text title="receipts.jsonl"
{"approver":{"member":"7b2e0000-0000-4000-8000-000000000001","role":"owner"},"decidedAt":"2026-11-12T09:30:00.125000Z","decision":"approved","decisionId":"1","draft":"8c3d0000-0000-4000-8000-000000000001","expiresAt":"2026-11-15T09:30:00.125000Z","hash":"a0f8ae47cb5a9a534d10a3245beacf054962a50590f98aa297f104cc2f2a31ed","kind":"email","org":"6a1f0000-0000-4000-8000-00000000c0de","payloadSha256":"eb672f315e6efd26cce4b5f45a73385f8bef43a24b4e0355164af0f5efb95a68","prev":"0000000000000000000000000000000000000000000000000000000000000000","seq":1,"v":1}
{"approver":{"member":"7b2e0000-0000-4000-8000-000000000002","role":"admin"},"decidedAt":"2026-11-12T09:31:10.500000Z","decision":"declined","decisionId":"2","draft":"8c3d0000-0000-4000-8000-000000000002","expiresAt":null,"hash":"a669bb4d71bfdeb4eef6230f31d2303bddeccd57ac1bb38f0aa411959c4d742a","kind":"email","org":"6a1f0000-0000-4000-8000-00000000c0de","payloadSha256":"9621362ff151967e70821ecb032343bf7352d265c4796149092c346cb3f62e6c","prev":"a0f8ae47cb5a9a534d10a3245beacf054962a50590f98aa297f104cc2f2a31ed","seq":2,"v":1}
```

and checks it offline:

```text title="Terminal" untested="Needs a database. apps/hosted/db/__tests__/receipts-docs.test.ts runs example.sql on a fresh database, exports the chain and compares the file and this output."
$ npx gaugeline receipts verify receipts.jsonl
```

```text title="Output"
Checked 2 receipts for organisation 6a1f0000-0000-4000-8000-00000000c0de: the chain is intact.
Every receipt's hash matches its fields, each links to the one before, and the first to the genesis value.
Head: a669bb4d71bfdeb4eef6230f31d2303bddeccd57ac1bb38f0aa411959c4d742a

This is tamper evidence, not a signature: whoever controls the database can rebuild the whole chain.
Keep the head hash somewhere the database's operator does not control and check later exports with --head.
```

Each receipt names the draft, the decision row, the person who decided and their role at that moment, the
time, the expiry (72 hours after an approval; none for a decline), and the SHA-256 of the exact payload they
saw: the database's own hash for an approval or an edit (the one the writer checks before it applies
anything), and the same hash of the draft's payload for a decline. It never holds the payload, so a
receipt can be shared without the page text or a secret pasted into a draft.

## How it is built

- **Same transaction.** An `AFTER INSERT` trigger on `public.decisions` writes the receipt. If the receipt
  cannot be written, the decision is not recorded either. Nothing about a decision row changes: the receipt
  is a row in a new table (ADR-0014 asks for an ADR before any change to ADR-0010's rows).
- **One choice, one receipt.** A double click inserts no second decision (`ON CONFLICT DO NOTHING`), so it
  fires nothing. Outcome rows the worker appends later are not choices and get no receipt.
- **No fork.** The organisation's chain head (`private.receipt_heads`) is locked while a receipt is written.
  Two choices at the same moment take turns: under `READ COMMITTED` (the default) the second waits and then
  links to the first; under `REPEATABLE READ` or `SERIALIZABLE` it fails and its decision rolls back. The
  table also refuses two receipts at one position, two that follow the same receipt, and two for one draft.
- **Append-only.** No role is granted `INSERT`, `UPDATE` or `DELETE` on `public.receipts`; a trigger refuses
  `UPDATE`, `DELETE` and `TRUNCATE` even for the table's owner.
- **Who reads it.** Owners and admins read their own organisation's chain (row-level security). Members,
  client viewers, the server's `service_role`, the agent and the worker read nothing. `GET /receipts`
  checks the role first and answers `403` to anyone else, so nobody is handed an empty chain that would
  verify as "nothing happened".
- **The same code checks it.** The canonical text is built in SQL (`private.receipt_text`) and in
  `@gaugeline/core`; a test builds both from the same inputs, and the export test runs the same verifier as
  the command.

## What it proves, and what it does not

**This is tamper evidence, not a signature.** A changed, removed, added or reordered receipt breaks the
chain unless every receipt after it is rewritten too. But the database's owner (the operator, or anyone with
the owner's password) can turn the triggers off and rebuild the whole chain, and every hash will match.

The defence is to keep the head hash somewhere the operator does not control (your notes, an email to the
client, a commit in your own repository) and check each later export with `--head`: the chain must still
contain it. Publishing the head there automatically (anchoring) is a later option and is not built. There
are no signatures, no keys and no WebAuthn in this version.

Not decided yet: how long receipts are kept (ADR-0014, "Needs from the owner"). Today they are kept.

# Verify approval receipts

Every draft a person approves, edits and approves, or declines in the hosted inbox gets a **receipt**: who
decided (their member id and their role at that moment), what they decided, when, when the approval
expires, and the SHA-256 of the exact payload they saw. Each receipt also carries the hash of the
organisation's previous receipt, so the receipts form a **hash chain**. `gaugeline receipts verify` checks
an exported chain on your own computer: no network, no account, no key.

## An example: a pop-up bar's approvals

A studio looks after a pop-up bar's site. In one week the inbox held four drafts: a redirect for the new
`/menu` page (approved by the studio's owner), the weekly email to the bar (declined by an admin), the
opening hours in the bar's content system (edited, then approved, by a member) and a pull request that
lets search engines index the launch site (approved). The studio exported the chain, kept the two payloads
it wanted to show the bar beside it, and checks it:

```text title="Terminal" untested="Needs an exported chain. packages/cli/src/__tests__/receipts-docs.test.ts runs this command on the invented chain in packages/fixtures/approval-receipts and compares the output."
$ npx gaugeline receipts verify pop-up-bar
```

```text title="Output"
Checked 4 receipts for organisation 6a1f0000-0000-4000-8000-00000000c0de: the chain is intact.
Every receipt's hash matches its fields, each links to the one before, and the first to the genesis value.
2 payloads beside the chain hash to their receipts.
Head: f438d8ae13da0ebfa26467a2fe058893bf55f65d2a67e4a979c1bc6292952928

This is tamper evidence, not a signature: whoever controls the database can rebuild the whole chain.
Keep the head hash somewhere the database's operator does not control and check later exports with --head.
```

The folder holds `receipts.jsonl` (the chain, one receipt per line) and `payloads/`, one file per draft
named `<draft id>.txt`, each the exact text the person saw. A payload file is optional; each one there must
hash to its receipt's `payloadSha256`, and its text is never printed. A file in `payloads/` with any other
name stops the check (exit 2), so nothing in the folder goes unchecked. You can also give the chain file
alone: `gaugeline receipts verify receipts.jsonl`.

Now someone changes the declined email's receipt so it says the owner declined it, not the admin:

```text title="Terminal" untested="Needs an exported chain. packages/cli/src/__tests__/receipts-docs.test.ts runs this command on the invented chain in packages/fixtures/approval-receipts and compares the output."
$ npx gaugeline receipts verify pop-up-bar-tampered
```

```text title="Output"
The chain breaks at receipt 2 (line 2): hash. The hash does not match the receipt's fields: a field was changed.
1 receipt before it checks out; nothing from receipt 2 (line 2) on can be trusted.

This is tamper evidence, not a signature: whoever controls the database can rebuild the whole chain.
Keep the head hash somewhere the database's operator does not control and check later exports with --head.
```

It exits 1. With `--json` it prints the same verdict for a script: `ok`, `receipts`, `verified` (the
receipts before the first problem), `payloads`, `org`, `head`, and `problem` with `index` (from 0), `line`
(from 1), `check` and `message`.

## What it checks, in order

For each receipt, it stops at the first that fails:

| Check             | Fails when                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------ |
| `parse`           | the line is not JSON (a blank line in the middle, a cut line, `NaN`)                                               |
| `schema`          | a field is missing, extra or the wrong shape; an unknown version; an expiry that does not follow from the decision |
| `canonical`       | the line is not the canonical form (keys sorted, no spaces, whole numbers only)                                    |
| `hash`            | the hash does not match the receipt's fields: a field was changed                                                  |
| `org`             | the receipt belongs to another organisation than the first one                                                     |
| `sequence`        | `seq` is not the receipt's position: a receipt was removed, added or moved                                         |
| `genesis`         | the first receipt does not start from the genesis value (64 zeros)                                                 |
| `link`            | `prev` is not the previous receipt's hash: the chain was rewritten from here                                       |
| `duplicate-draft` | a draft has a second receipt (one decision per draft)                                                              |
| `payload`         | a payload beside the chain does not hash to its receipt, or has no receipt                                         |
| `head`            | the head given with `--head` is not in the chain                                                                   |

Exit codes: 0 the chain checks out, 1 a problem was found, 2 the file or folder could not be read.

## What it proves, and what it does not

**This is tamper evidence, not a signature.** A receipt chain proves that nobody changed, removed,
added or reordered a receipt _without also rewriting every receipt after it_. It does not prove who
wrote the chain.

- Whoever controls the database (the operator, or someone with the database owner's password) can rebuild
  the whole chain from the first receipt, and every hash will match. The check cannot tell.
- A chain cut off at the end looks complete: the last receipts are simply not there.

Both are found by **comparing the head** with one you wrote down earlier, somewhere the operator does not
control: your own notes, an email to the client, a commit in your own repository. A later export must still
contain that head:

```text title="Terminal" untested="Needs an exported chain. packages/cli/src/__tests__/receipts-docs.test.ts runs this command on the invented chain in packages/fixtures/approval-receipts and checks the exit code."
$ npx gaugeline receipts verify pop-up-bar --head f438d8ae13da0ebfa26467a2fe058893bf55f65d2a67e4a979c1bc6292952928
```

Publishing the head automatically to a place the operator does not control (anchoring) is a later
option; it is not built, and nothing here sends a head anywhere. There are no signatures, no keys and no
WebAuthn in this version.

The receipt holds the **hash** of the payload, never the payload: a draft can hold page text or a secret
pasted by mistake, and the chain is meant to be kept and shared. Keep a payload beside the chain only when
you mean to share it.

## The format (version 1)

One receipt per line, UTF-8, each line the canonical JSON of one object with exactly these fields:

| Field           | Holds                                                                                                    |
| --------------- | -------------------------------------------------------------------------------------------------------- |
| `v`             | `1`, the format version                                                                                  |
| `org`           | the organisation's id (a lower-case uuid)                                                                |
| `seq`           | 1 for the organisation's first receipt, then one more each time                                          |
| `draft`         | the draft's id                                                                                           |
| `decisionId`    | the decision row's id, as decimal text                                                                   |
| `kind`          | the draft kind: `pull_request`, `email` or `sanity_draft`                                                |
| `decision`      | `approved`, `edited` or `declined`                                                                       |
| `payloadSha256` | SHA-256 of the exact payload the person saw (the edit, for `edited`)                                     |
| `approver`      | `member` (the person's user id) and `role` at that moment (`owner`, `admin`, `member`, `client` or null) |
| `decidedAt`     | UTC with six fraction digits, for example `2026-11-02T09:15:04.218734Z`                                  |
| `expiresAt`     | `decidedAt` plus 72 hours for an approval; null for a decline                                            |
| `prev`          | the previous receipt's `hash`, or 64 zeros for the first                                                 |
| `hash`          | SHA-256 of the canonical JSON of every other field                                                       |

Canonical JSON here is a strict subset of RFC 8785 (the JSON Canonicalization Scheme): keys sorted by
UTF-16 code unit, no whitespace, strings as JSON writes them, whole numbers up to 2^53 - 1 only (no
fractions, exponents, `NaN` or infinities), hashed as UTF-8 bytes. The verifier is also a library function
in `@gaugeline/core` (`verifyApprovalReceipts`), the same code the hosted export's tests run.

The 72-hour expiry is ADR-0010's proposed value (uncited), the same one the writer enforces.

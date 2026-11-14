# approval-receipts

Invented receipt chains for `gaugeline receipts verify` (AG-06). Nothing here is a real business, person or
organisation; every id is made up.

- `pop-up-bar/`: the passing fixture. A studio's chain of four receipts for a pop-up bar's drafts (a redirect,
  a declined weekly email, edited opening hours, an indexing fix), with two of the payloads beside it in
  `payloads/<draft id>.txt`.
- `pop-up-bar-tampered/`: the failing fixture. The same chain with the second receipt's role changed from
  admin to owner and its hash left alone: the verifier stops at receipt 2 with `hash`.

The guide (docs/guides/verify-receipts.md) shows the output for both, and a test compares it, so these files
are pinned: regenerate them only together with the guide.

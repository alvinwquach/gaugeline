/**
 * AG-10, the receipt chain's half of the red-team suite (ADR-0014 T3, T5): a replayed approval, a draft
 * edited after approval, a reordered or cut chain. Each must FAIL the offline verifier, naming the first bad
 * receipt. Test-only; the controls are listed in docs/hosted/agent-red-team.md. Invented ids, fixed times.
 */
import { describe, expect, it } from "vitest";
import { sha256Hex } from "../canonical.js";
import {
  approvalReceiptLine,
  buildApprovalReceiptChain,
  verifyApprovalReceipts,
  type ApprovalReceiptInput,
} from "../chain.js";

const ORG = "0a000000-0000-4000-8000-000000000001";
const MEMBER = "0b000000-0000-4000-8000-000000000001";
const draft = (n: number) => `0d000000-0000-4000-8000-00000000000${n}`;
const PAYLOADS = ['{"body":"Menu fixed","subject":"Menu"}', '{"body":"Hours","subject":"Hours"}'];
const input = (n: number, text: string): ApprovalReceiptInput => ({
  org: ORG,
  draft: draft(n),
  decisionId: String(10 + n),
  kind: "email",
  decision: "approved",
  payloadSha256: sha256Hex(text),
  approver: { member: MEMBER, role: "owner" },
  decidedAt: `2026-11-13T09:0${n}:00.000000Z`,
});
const chain = buildApprovalReceiptChain([input(1, PAYLOADS[0]!), input(2, PAYLOADS[1]!)]);
const text = (rs: readonly unknown[]) =>
  rs.map((r) => approvalReceiptLine(r as (typeof chain)[number])).join("\n") + "\n";

describe("red team: the approval receipt chain (T3, T5)", () => {
  it("passing fixture: an untouched chain verifies, with the payloads the people saw", () => {
    const payloads = new Map([
      [draft(1), PAYLOADS[0]!],
      [draft(2), PAYLOADS[1]!],
    ]);
    expect(verifyApprovalReceipts(text(chain), { payloads })).toMatchObject({
      ok: true,
      verified: 2,
    });
  });

  it("replayed approval: a receipt copied to the end, or a second approval of the same draft, breaks the chain", () => {
    const copied = verifyApprovalReceipts(text([...chain, chain[0]]));
    expect(copied).toMatchObject({ ok: false, problem: { index: 2, check: "sequence" } });
    const again = buildApprovalReceiptChain([
      input(1, PAYLOADS[0]!),
      input(2, PAYLOADS[1]!),
      input(1, PAYLOADS[0]!),
    ]);
    expect(verifyApprovalReceipts(text(again))).toMatchObject({
      ok: false,
      problem: { index: 2, check: "duplicate-draft" },
    });
  });

  it("approval of an edited draft: a payload that is not the one hashed is named, and a receipt's hash edited in place fails", () => {
    const edited = new Map([
      [draft(1), PAYLOADS[0]!.replace("Menu fixed", "Menu fixed, and a free round")],
    ]);
    expect(verifyApprovalReceipts(text(chain), { payloads: edited })).toMatchObject({
      ok: false,
      problem: { index: 0, check: "payload" },
    });
    const swapped = { ...chain[0]!, payloadSha256: sha256Hex("something else") };
    expect(verifyApprovalReceipts(text([swapped, chain[1]]))).toMatchObject({
      ok: false,
      problem: { index: 0, check: "hash" },
    });
  });

  it("reordered, cut or forged chains fail: a swap, a missing first receipt, a changed approver, a cut-off end", () => {
    expect(verifyApprovalReceipts(text([chain[1], chain[0]])).ok).toBe(false);
    expect(verifyApprovalReceipts(text([chain[1]])).ok).toBe(false);
    const forged = { ...chain[1]!, approver: { member: MEMBER, role: "client" as const } };
    expect(verifyApprovalReceipts(text([chain[0], forged]))).toMatchObject({
      problem: { index: 1, check: "hash" },
    });
    expect(verifyApprovalReceipts(text([chain[0]]), { head: chain[1]!.hash })).toMatchObject({
      ok: false,
      problem: { check: "head" },
    });
  });
});

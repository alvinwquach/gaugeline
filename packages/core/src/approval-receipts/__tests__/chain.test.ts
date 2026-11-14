import { describe, expect, it } from "vitest";
import { canonicalJson, sha256Hex } from "../canonical.js";
import {
  APPROVAL_RECEIPT_GENESIS,
  APPROVAL_RECEIPT_VERSION,
  ApprovalReceiptError,
  approvalReceiptHash,
  approvalReceiptLine,
  buildApprovalReceipt,
  buildApprovalReceiptChain,
  approvalReceiptExpiry,
  approvalReceiptTime,
  verifyApprovalReceipts,
  type ApprovalReceipt,
  type ApprovalReceiptInput,
} from "../chain.js";

// Invented ids (rule 12): one studio's organisation, three people, four drafts.
const ORG = "0a000000-0000-4000-8000-000000000001";
const OTHER_ORG = "0a000000-0000-4000-8000-000000000002";
const OWNER = "0b000000-0000-4000-8000-000000000001";
const ADMIN = "0b000000-0000-4000-8000-000000000002";
const MEMBER = "0b000000-0000-4000-8000-000000000003";
const draft = (n: number) => `0d000000-0000-4000-8000-00000000000${n}`;
const PAYLOAD = (text: string) => sha256Hex(text);

const inputs: ApprovalReceiptInput[] = [
  {
    org: ORG,
    draft: draft(1),
    decisionId: "11",
    kind: "pull_request",
    decision: "approved",
    payloadSha256: PAYLOAD('{"body": "", "files": [], "title": "Add the /menu redirect"}'),
    approver: { member: OWNER, role: "owner" },
    decidedAt: "2026-11-02T09:15:00.000000Z",
  },
  {
    org: ORG,
    draft: draft(2),
    decisionId: "12",
    kind: "email",
    decision: "declined",
    payloadSha256: PAYLOAD('{"body": "Hello", "subject": "Your weekly update"}'),
    approver: { member: ADMIN, role: "admin" },
    decidedAt: "2026-11-02T10:00:00.250000Z",
  },
  {
    org: ORG,
    draft: draft(3),
    decisionId: "14",
    kind: "sanity_draft",
    decision: "edited",
    payloadSha256: PAYLOAD(
      '{"documentId": "hours", "documentType": "venue", "set": {"open": "5pm"}}',
    ),
    approver: { member: MEMBER, role: "member" },
    decidedAt: "2026-11-03T18:30:12.123456Z",
  },
  {
    org: ORG,
    draft: draft(4),
    decisionId: "15",
    kind: "pull_request",
    decision: "approved",
    payloadSha256: PAYLOAD('{"body": "", "files": [], "title": "Fix the share picture"}'),
    approver: { member: OWNER, role: "owner" },
    decidedAt: "2026-11-04T07:00:00.000000Z",
  },
];

const chain = buildApprovalReceiptChain(inputs);
const text = (rs: readonly ApprovalReceipt[]) => rs.map(approvalReceiptLine).join("\n") + "\n";
const lines = () => text(chain).trimEnd().split("\n");
const join = (ls: string[]) => ls.join("\n") + "\n";
/** A receipt with one field changed and its own hash recomputed (an editor who knows the format). */
const rehash = (r: ApprovalReceipt, change: Partial<ApprovalReceipt>): ApprovalReceipt => {
  const next = { ...r, ...change };
  return { ...next, hash: approvalReceiptHash(next) };
};

describe("receipt times", () => {
  it("prints UTC with six fraction digits, from a Date", () => {
    expect(approvalReceiptTime(new Date("2026-11-02T09:15:00.120Z"))).toBe(
      "2026-11-02T09:15:00.120000Z",
    );
  });
  it("an approval expires 72 hours later to the microsecond; a decline has no expiry", () => {
    expect(approvalReceiptExpiry("approved", "2026-11-02T09:15:00.123456Z")).toBe(
      "2026-11-05T09:15:00.123456Z",
    );
    expect(approvalReceiptExpiry("edited", "2026-12-30T23:59:59.999999Z")).toBe(
      "2027-01-02T23:59:59.999999Z",
    );
    expect(approvalReceiptExpiry("declined", "2026-11-02T09:15:00.000000Z")).toBeNull();
  });
});

describe("building a chain", () => {
  it("the first receipt commits to the genesis value, each next one to the one before", () => {
    expect(APPROVAL_RECEIPT_GENESIS).toBe("0".repeat(64));
    expect(chain[0]?.prev).toBe(APPROVAL_RECEIPT_GENESIS);
    for (let i = 1; i < chain.length; i++) expect(chain[i]?.prev).toBe(chain[i - 1]?.hash);
    expect(chain.map((r) => r.seq)).toEqual([1, 2, 3, 4]);
  });

  it("the hash is SHA-256 of the canonical JSON of every field but the hash", () => {
    const r = chain[0] as ApprovalReceipt;
    const { hash, ...rest } = r;
    expect(hash).toBe(sha256Hex(canonicalJson(rest)));
    expect(approvalReceiptLine(r)).toBe(canonicalJson(r));
    expect(r.v).toBe(APPROVAL_RECEIPT_VERSION);
  });

  it("is deterministic: the same inputs give the same chain, byte for byte (a pinned head)", () => {
    expect(text(buildApprovalReceiptChain(inputs))).toBe(text(chain));
    // Pinned so a change to the format cannot pass unnoticed: it is a new version, not an edit.
    expect(chain[3]?.hash).toMatchInlineSnapshot(
      `"1af94858f8493e553a69a981ba5e7f2a8f54aac43ec1114ad0367579376626de"`,
    );
  });

  it("carries the hash of the payload, never the payload, and the approver's role at the time", () => {
    const line = approvalReceiptLine(chain[0] as ApprovalReceipt);
    expect(line).not.toContain("menu");
    expect(chain[0]?.approver).toEqual({ member: OWNER, role: "owner" });
    expect(chain[1]?.expiresAt).toBeNull();
    expect(chain[0]?.expiresAt).toBe("2026-11-05T09:15:00.000000Z");
  });

  it("takes the time from the injected clock when the input has none", () => {
    const { decidedAt: _, ...rest } = inputs[0] as ApprovalReceiptInput;
    const r = buildApprovalReceipt(rest, null, () => new Date("2026-11-10T00:00:00.000Z"));
    expect(r.decidedAt).toBe("2026-11-10T00:00:00.000000Z");
  });

  it("refuses an input that does not fit the format", () => {
    const base = inputs[0] as ApprovalReceiptInput;
    const bad: Partial<ApprovalReceiptInput>[] = [
      { org: "not-a-uuid" },
      { draft: "0D000000-0000-4000-8000-000000000001" },
      { decisionId: "0" },
      { decisionId: "1.5" },
      { kind: "Pull Request" },
      { decision: "maybe" as never },
      { payloadSha256: "ABC" },
      { approver: { member: OWNER, role: "boss" as never } },
      { decidedAt: "2026-11-02T09:15:00Z" },
      { decidedAt: "2026-13-02T09:15:00.000000Z" },
    ];
    for (const b of bad)
      expect(() => buildApprovalReceipt({ ...base, ...b }, null), JSON.stringify(b)).toThrow(
        ApprovalReceiptError,
      );
  });

  it("refuses a previous receipt from another organisation", () => {
    expect(() =>
      buildApprovalReceipt(
        { ...(inputs[1] as ApprovalReceiptInput), org: OTHER_ORG },
        chain[0] ?? null,
      ),
    ).toThrow(/organisation/);
  });

  it("a role can be null (a decision recorded for someone who is no longer a member)", () => {
    const r = buildApprovalReceipt(
      { ...(inputs[0] as ApprovalReceiptInput), approver: { member: OWNER, role: null } },
      null,
    );
    expect(r.approver.role).toBeNull();
    expect(verifyApprovalReceipts(text([r])).ok).toBe(true);
  });
});

describe("verifying a chain: intact", () => {
  it("passes, with the count, the organisation and the head", () => {
    expect(verifyApprovalReceipts(text(chain))).toEqual({
      ok: true,
      receipts: 4,
      verified: 4,
      org: ORG,
      head: chain[3]?.hash,
    });
  });

  it("an empty file is an empty chain: nothing to check, the head is the genesis value", () => {
    expect(verifyApprovalReceipts("")).toEqual({
      ok: true,
      receipts: 0,
      verified: 0,
      org: null,
      head: APPROVAL_RECEIPT_GENESIS,
    });
  });

  it("a file without a final newline reads the same", () => {
    expect(verifyApprovalReceipts(text(chain).trimEnd()).ok).toBe(true);
  });

  it("--head: passes when the head written down earlier is in the chain", () => {
    expect(verifyApprovalReceipts(text(chain), { head: chain[1]?.hash }).ok).toBe(true);
    expect(verifyApprovalReceipts(text(chain), { head: chain[3]?.hash }).ok).toBe(true);
  });

  it("payloads beside the chain that hash to their receipts pass", () => {
    const payloads = new Map([
      [draft(1), '{"body": "", "files": [], "title": "Add the /menu redirect"}'],
      [draft(2), '{"body": "Hello", "subject": "Your weekly update"}'],
    ]);
    expect(verifyApprovalReceipts(text(chain), { payloads }).ok).toBe(true);
  });
});

describe("verifying a chain: every tamper case names the first broken receipt and what failed", () => {
  const broken = (t: string, opts?: Parameters<typeof verifyApprovalReceipts>[1]) => {
    const v = verifyApprovalReceipts(t, opts);
    expect(v.ok).toBe(false);
    return v.problem;
  };

  it("a changed field (the role, hash left alone)", () => {
    const ls = lines();
    ls[1] = (ls[1] ?? "").replace('"role":"admin"', '"role":"owner"');
    expect(broken(join(ls))).toMatchObject({ index: 1, line: 2, check: "hash" });
  });

  it("a changed field with its own hash recomputed breaks the link from the next receipt", () => {
    const rs = [...chain];
    rs[1] = rehash(rs[1] as ApprovalReceipt, {
      decision: "approved",
      expiresAt: "2026-11-05T10:00:00.250000Z",
    });
    const v = verifyApprovalReceipts(text(rs));
    expect(v.problem).toMatchObject({ index: 2, check: "link" });
    expect(v.verified).toBe(2);
  });

  it("a changed payload hash", () => {
    const rs = [...chain];
    rs[2] = { ...(rs[2] as ApprovalReceipt), payloadSha256: PAYLOAD("something else") };
    expect(broken(text(rs))).toMatchObject({ index: 2, check: "hash" });
  });

  it("a removed receipt", () => {
    const ls = lines();
    ls.splice(1, 1);
    expect(broken(join(ls))).toMatchObject({ index: 1, check: "sequence" });
  });

  it("two receipts swapped", () => {
    const ls = lines();
    [ls[1], ls[2]] = [ls[2] ?? "", ls[1] ?? ""];
    expect(broken(join(ls))).toMatchObject({ index: 1, check: "sequence" });
  });

  it("a removed receipt with the rest renumbered and rehashed except the link", () => {
    const rs = [chain[0], ...chain.slice(2)].map((r) => r as ApprovalReceipt);
    rs[1] = rehash(rs[1] as ApprovalReceipt, { seq: 2 });
    expect(broken(text(rs.slice(0, 2)))).toMatchObject({ index: 1, check: "link" });
  });

  it("a fork: two receipts that both follow the same one", () => {
    const fork = rehash(chain[2] as ApprovalReceipt, { draft: draft(9) });
    expect(broken(text([...chain.slice(0, 3), fork]))).toMatchObject({
      index: 3,
      check: "sequence",
    });
  });

  it("a wrong genesis value", () => {
    const first = rehash(chain[0] as ApprovalReceipt, { prev: "f".repeat(64) });
    expect(broken(text([first]))).toMatchObject({ index: 0, check: "genesis" });
  });

  it("a chain that does not start at 1", () => {
    expect(broken(text(chain.slice(1)))).toMatchObject({ index: 0, check: "sequence" });
  });

  it("a receipt from another organisation", () => {
    const rs = [...chain];
    rs[1] = rehash(rs[1] as ApprovalReceipt, { org: OTHER_ORG });
    expect(broken(text(rs))).toMatchObject({ index: 1, check: "org" });
  });

  it("the same draft twice (a replayed approval written into a rebuilt chain)", () => {
    const rebuilt = buildApprovalReceiptChain([
      ...inputs,
      { ...(inputs[0] as ApprovalReceiptInput), decisionId: "16" },
    ]);
    expect(broken(text(rebuilt))).toMatchObject({ index: 4, check: "duplicate-draft" });
  });

  it("a swapped payload beside the chain", () => {
    const payloads = new Map([[draft(4), '{"body": "", "files": [], "title": "Something else"}']]);
    expect(broken(text(chain), { payloads })).toMatchObject({ index: 3, check: "payload" });
  });

  it("a payload beside the chain with no receipt", () => {
    const payloads = new Map([[draft(8), "{}"]]);
    expect(broken(text(chain), { payloads })).toMatchObject({ index: 4, check: "payload" });
  });

  it("a cut-off end is only found with --head", () => {
    expect(verifyApprovalReceipts(text(chain.slice(0, 2))).ok).toBe(true);
    expect(broken(text(chain.slice(0, 2)), { head: chain[3]?.hash })).toMatchObject({
      index: 2,
      check: "head",
    });
  });

  it("a --head that is not a SHA-256 is a problem with the head, not a pass", () => {
    expect(broken(text(chain), { head: "abc" })).toMatchObject({ check: "head" });
  });

  it("a line that is not JSON, and a blank line in the middle", () => {
    const ls = lines();
    ls[2] = "{not json";
    expect(broken(join(ls))).toMatchObject({ index: 2, line: 3, check: "parse" });
    const gap = lines();
    gap.splice(1, 0, "");
    expect(broken(join(gap))).toMatchObject({ index: 1, check: "parse" });
  });

  it("NaN, a float and extra spaces are not the canonical form", () => {
    const ls = lines();
    expect(broken(join([(ls[0] ?? "").replace('"seq":1', '"seq":NaN')]))).toMatchObject({
      check: "parse",
    });
    expect(broken(join([(ls[0] ?? "").replace('"seq":1', '"seq":1.0')]))).toMatchObject({
      check: "canonical",
    });
    expect(broken(join([(ls[0] ?? "").replace('"seq":1', '"seq": 1')]))).toMatchObject({
      check: "canonical",
    });
    expect(broken(join([(ls[0] ?? "").replace('"seq":1', '"seq":1.5')]))).toMatchObject({
      check: "schema",
    });
  });

  it("keys in another order are not the canonical form", () => {
    const r = chain[0] as ApprovalReceipt;
    const { v, ...rest } = r;
    expect(broken(`${JSON.stringify({ v, ...rest })}\n`)).toMatchObject({ check: "canonical" });
  });

  it("a field too many, a field missing, an unknown version", () => {
    const r = chain[0] as ApprovalReceipt;
    expect(broken(`${canonicalJson({ ...r, note: "x" })}\n`)).toMatchObject({ check: "schema" });
    const { kind: _, ...missing } = r;
    expect(broken(`${canonicalJson(missing)}\n`)).toMatchObject({ check: "schema" });
    expect(broken(`${canonicalJson(rehash(r, { v: 2 as never }))}\n`)).toMatchObject({
      check: "schema",
      message: expect.stringMatching(/version 2/),
    });
  });

  it("an expiry that does not follow from the decision", () => {
    const r = chain[1] as ApprovalReceipt;
    expect(
      broken(
        text([
          chain[0] as ApprovalReceipt,
          rehash(r, { expiresAt: "2026-11-05T10:00:00.250000Z" }),
        ]),
      ),
    ).toMatchObject({ index: 1, check: "schema" });
    const a = chain[0] as ApprovalReceipt;
    expect(broken(text([rehash(a, { expiresAt: "2026-11-09T09:15:00.000000Z" })]))).toMatchObject({
      index: 0,
      check: "schema",
    });
  });

  it("the payload text never appears in a problem's message", () => {
    const secret = '{"body": "token-like-value", "subject": "x"}';
    const v = verifyApprovalReceipts(text(chain), { payloads: new Map([[draft(1), secret]]) });
    expect(JSON.stringify(v)).not.toContain("token-like-value");
  });
});

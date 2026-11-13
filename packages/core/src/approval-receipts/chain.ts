/**
 * Approval receipts (AG-06): one record per decided draft, chained per organisation by hash, and the
 * offline check of a chain. The hosted database writes the same records in the transaction that records
 * a decision (migration 0016_receipts.sql builds the same canonical text in SQL; a test runs both over
 * one set of inputs), and `gaugeline receipts verify` runs verifyApprovalReceipts on an exported file.
 *
 * What a chain proves: no receipt in it was changed, removed, added or moved after the next one was
 * written, unless every later receipt was rewritten too. It is tamper evidence, not a signature: whoever
 * controls the database can rebuild the whole chain. Comparing the head with one written down elsewhere
 * (`head` below) is what finds that, and a cut-off end.
 *
 * A receipt carries the SHA-256 of the payload the person saw, never the payload: a draft can hold page
 * text or a secret pasted by mistake. A person's copy may carry the payloads beside the chain; they are
 * checked against the hashes and never printed.
 *
 * Pure: no I/O, no network, no key. The clock is handed in.
 */
import { CanonicalJsonError, canonicalJson, sha256Hex } from "./canonical.js";

export const APPROVAL_RECEIPT_VERSION = 1;
/** The `prev` of an organisation's first receipt. */
export const APPROVAL_RECEIPT_GENESIS = "0".repeat(64);
/** How long an approval stays good: ADR-0010 part 2 (proposed 72 hours, uncited), as the writer uses it. */
export const APPROVAL_TTL_HOURS = 72;

export const APPROVAL_RECEIPT_DECISIONS = ["approved", "edited", "declined"] as const;
export type ApprovalReceiptDecision = (typeof APPROVAL_RECEIPT_DECISIONS)[number];
/** A member's role in public.members (0001_tables.sql). */
export const APPROVAL_RECEIPT_ROLES = ["owner", "admin", "member", "client"] as const;
export type ApprovalReceiptRole = (typeof APPROVAL_RECEIPT_ROLES)[number];

export interface ApprovalReceipt {
  v: typeof APPROVAL_RECEIPT_VERSION;
  /** The organisation whose chain this is. */
  org: string;
  /** 1 for an organisation's first receipt, then one more each time. */
  seq: number;
  draft: string;
  /** The decisions row's id, as decimal text (a bigint can pass 2^53). */
  decisionId: string;
  kind: string;
  decision: ApprovalReceiptDecision;
  /** SHA-256 of the exact payload the person saw: the draft's, or the edit's for "edited". */
  payloadSha256: string;
  /** Who decided, and their role in the organisation at that moment (null: not a member then). */
  approver: { member: string; role: ApprovalReceiptRole | null };
  /** UTC, six fraction digits: 2026-11-02T09:15:00.000000Z. */
  decidedAt: string;
  /** decidedAt plus 72 hours for an approval; null for a decline. */
  expiresAt: string | null;
  /** The previous receipt's hash, or APPROVAL_RECEIPT_GENESIS. */
  prev: string;
  /** SHA-256 of the canonical JSON of every other field. */
  hash: string;
}

export type ApprovalReceiptInput = Omit<
  ApprovalReceipt,
  "v" | "seq" | "prev" | "hash" | "expiresAt" | "decidedAt"
> & { decidedAt?: string };

export class ApprovalReceiptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalReceiptError";
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const DECISION_ID = /^[1-9][0-9]{0,18}$/;
const KIND = /^[a-z][a-z0-9_-]{0,39}$/;
const TIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})\.(\d{3})(\d{3})Z$/;
const KEYS = [
  "approver",
  "decidedAt",
  "decision",
  "decisionId",
  "draft",
  "expiresAt",
  "hash",
  "kind",
  "org",
  "payloadSha256",
  "prev",
  "seq",
  "v",
].join(",");

/** A Date as a receipt time: UTC, microseconds (always ...000 from a Date, which holds milliseconds). */
export function approvalReceiptTime(date: Date): string {
  const iso = date.toISOString();
  if (!/^\d{4}-/.test(iso))
    throw new ApprovalReceiptError("the time is outside years 0000 to 9999");
  return `${iso.slice(0, 23)}000Z`;
}

/** The milliseconds a receipt time stands for, or null when it is not one (a 13th month, a 25th hour). */
function timeMs(t: string): number | null {
  const m = TIME.exec(t);
  if (!m) return null;
  const ms = Date.parse(`${t.slice(0, 23)}Z`);
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 23) !== t.slice(0, 23))
    return null;
  return ms;
}

/** When an approval made at `decidedAt` expires (72 hours later, to the microsecond); null for a decline. */
export function approvalReceiptExpiry(
  decision: ApprovalReceiptDecision,
  decidedAt: string,
): string | null {
  if (decision === "declined") return null;
  const ms = timeMs(decidedAt);
  if (ms === null) throw new ApprovalReceiptError("decidedAt is not a receipt time");
  return `${new Date(ms + APPROVAL_TTL_HOURS * 3_600_000).toISOString().slice(0, 23)}${decidedAt.slice(23)}`;
}

/** What is wrong with a parsed record's shape, or null. Never quotes a value. */
function shapeProblem(r: unknown): string | null {
  if (r === null || typeof r !== "object" || Array.isArray(r)) return "a receipt is a JSON object";
  const o = r as Record<string, unknown>;
  if (o.v !== APPROVAL_RECEIPT_VERSION)
    return typeof o.v === "number"
      ? `version ${o.v} is not one this verifier knows (it knows ${APPROVAL_RECEIPT_VERSION})`
      : "v must be the format version";
  if (Object.keys(o).sort().join(",") !== KEYS) return `the fields must be exactly: ${KEYS}`;
  const field = (ok: boolean, name: string, what: string) =>
    ok ? null : `${name} must be ${what}`;
  const a = o.approver;
  const approverOk =
    a !== null &&
    typeof a === "object" &&
    !Array.isArray(a) &&
    Object.keys(a).sort().join(",") === "member,role" &&
    typeof (a as { member: unknown }).member === "string" &&
    UUID.test((a as { member: string }).member) &&
    ((a as { role: unknown }).role === null ||
      (APPROVAL_RECEIPT_ROLES as readonly unknown[]).includes((a as { role: unknown }).role));
  const decision = o.decision as ApprovalReceiptDecision;
  const problem =
    field(typeof o.org === "string" && UUID.test(o.org), "org", "a lower-case uuid") ??
    field(Number.isSafeInteger(o.seq) && (o.seq as number) >= 1, "seq", "a whole number from 1") ??
    field(typeof o.draft === "string" && UUID.test(o.draft), "draft", "a lower-case uuid") ??
    field(
      typeof o.decisionId === "string" && DECISION_ID.test(o.decisionId),
      "decisionId",
      "a positive whole number as text",
    ) ??
    field(typeof o.kind === "string" && KIND.test(o.kind), "kind", "a draft kind") ??
    field(
      (APPROVAL_RECEIPT_DECISIONS as readonly unknown[]).includes(o.decision),
      "decision",
      "approved, edited or declined",
    ) ??
    field(
      typeof o.payloadSha256 === "string" && HEX64.test(o.payloadSha256),
      "payloadSha256",
      "a SHA-256 in lower-case hex",
    ) ??
    field(approverOk, "approver", "{member: a uuid, role: owner, admin, member, client or null}") ??
    field(
      typeof o.decidedAt === "string" && timeMs(o.decidedAt) !== null,
      "decidedAt",
      "a UTC time with six fraction digits",
    ) ??
    field(
      typeof o.prev === "string" && HEX64.test(o.prev),
      "prev",
      "a SHA-256 in lower-case hex",
    ) ??
    field(typeof o.hash === "string" && HEX64.test(o.hash), "hash", "a SHA-256 in lower-case hex");
  if (problem) return problem;
  if (o.expiresAt !== approvalReceiptExpiry(decision, o.decidedAt as string))
    return decision === "declined"
      ? "expiresAt must be null for a decline"
      : `expiresAt must be decidedAt plus ${APPROVAL_TTL_HOURS} hours for an approval`;
  return null;
}

/** The hash a receipt should carry: SHA-256 of the canonical JSON of every field but `hash`. */
export function approvalReceiptHash(r: Omit<ApprovalReceipt, "hash"> & { hash?: string }): string {
  const { hash: _ignored, ...rest } = r;
  return sha256Hex(canonicalJson(rest));
}

/** One receipt as its line in a chain file (canonical JSON, no newline). */
export function approvalReceiptLine(r: ApprovalReceipt): string {
  return canonicalJson(r);
}

/**
 * The receipt that follows `prev` (null: the organisation's first). The time is the input's, or the
 * clock's when it has none. Throws ApprovalReceiptError on anything outside the format.
 */
export function buildApprovalReceipt(
  input: ApprovalReceiptInput,
  prev: ApprovalReceipt | null,
  clock: () => Date = () => new Date(),
): ApprovalReceipt {
  if (prev && prev.org !== input.org)
    throw new ApprovalReceiptError("the previous receipt belongs to another organisation");
  const decidedAt = input.decidedAt ?? approvalReceiptTime(clock());
  if (timeMs(decidedAt) === null)
    throw new ApprovalReceiptError("decidedAt must be a UTC time with six fraction digits");
  const body = {
    v: APPROVAL_RECEIPT_VERSION,
    org: input.org,
    seq: prev ? prev.seq + 1 : 1,
    draft: input.draft,
    decisionId: input.decisionId,
    kind: input.kind,
    decision: input.decision,
    payloadSha256: input.payloadSha256,
    approver: { member: input.approver.member, role: input.approver.role },
    decidedAt,
    expiresAt: (APPROVAL_RECEIPT_DECISIONS as readonly unknown[]).includes(input.decision)
      ? approvalReceiptExpiry(input.decision, decidedAt)
      : null,
    prev: prev ? prev.hash : APPROVAL_RECEIPT_GENESIS,
  } as const;
  let hash: string;
  try {
    hash = approvalReceiptHash(body);
  } catch (e) {
    throw new ApprovalReceiptError(
      e instanceof CanonicalJsonError ? e.message : "not canonical JSON",
    );
  }
  const receipt: ApprovalReceipt = { ...body, hash };
  const problem = shapeProblem(receipt);
  if (problem) throw new ApprovalReceiptError(problem);
  return receipt;
}

/** A whole chain from its inputs, in order. */
export function buildApprovalReceiptChain(
  inputs: readonly ApprovalReceiptInput[],
  clock?: () => Date,
): ApprovalReceipt[] {
  const out: ApprovalReceipt[] = [];
  for (const input of inputs) out.push(buildApprovalReceipt(input, out.at(-1) ?? null, clock));
  return out;
}

/** What failed, in the order the verifier checks a receipt. */
export const APPROVAL_RECEIPT_CHECKS = [
  "parse",
  "schema",
  "canonical",
  "hash",
  "org",
  "sequence",
  "genesis",
  "link",
  "duplicate-draft",
  "payload",
  "head",
] as const;
export type ApprovalReceiptCheck = (typeof APPROVAL_RECEIPT_CHECKS)[number];

export interface ApprovalReceiptProblem {
  /** 0-based position of the first receipt that fails (the receipt count for a check after the end). */
  index: number;
  /** 1-based line in the file. */
  line: number;
  check: ApprovalReceiptCheck;
  message: string;
}

export interface ApprovalReceiptVerdict {
  ok: boolean;
  /** Receipts in the file. */
  receipts: number;
  /** Receipts before the first problem: these check out. */
  verified: number;
  /** The organisation of the first receipt, or null for an empty chain. */
  org: string | null;
  /** The hash of the last receipt that checks out (the genesis value when none does). */
  head: string;
  problem?: ApprovalReceiptProblem;
}

export interface ApprovalReceiptVerifyOptions {
  /** A person's copy: draft id to the exact payload text the receipt hashed. Never printed. */
  payloads?: ReadonlyMap<string, string>;
  /** A head hash written down earlier: the chain must still contain it. */
  head?: string;
}

/**
 * Check a chain file (JSON lines) with no network and no key. Stops at the first receipt that fails and
 * says which and why; everything before it checks out. In order, for each receipt: it is JSON, it has the
 * format's fields and nothing else, its line is the canonical form, its hash matches its fields, it is the
 * first receipt's organisation, its seq is its position, it links to the genesis value or the receipt
 * before, and its draft has no earlier receipt. Then each payload given hashes to its receipt, and `head`
 * is in the chain.
 */
export function verifyApprovalReceipts(
  text: string,
  opts: ApprovalReceiptVerifyOptions = {},
): ApprovalReceiptVerdict {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const receipts: ApprovalReceipt[] = [];
  const total = lines.length;
  const fail = (
    index: number,
    check: ApprovalReceiptCheck,
    message: string,
  ): ApprovalReceiptVerdict => ({
    ok: false,
    receipts: total,
    verified: receipts.length,
    org: receipts[0]?.org ?? null,
    head: receipts.at(-1)?.hash ?? APPROVAL_RECEIPT_GENESIS,
    problem: { index, line: index + 1, check, message },
  });
  const drafts = new Map<string, number>();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      return fail(i, "parse", "the line is not JSON");
    }
    const shape = shapeProblem(parsed);
    if (shape) return fail(i, "schema", shape);
    const r = parsed as ApprovalReceipt;
    let canonical: string;
    try {
      canonical = canonicalJson(r);
    } catch (e) {
      return fail(i, "canonical", e instanceof Error ? e.message : "not canonical JSON");
    }
    if (canonical !== line)
      return fail(
        i,
        "canonical",
        "the line is not in canonical form (sorted keys, no spaces, whole numbers)",
      );
    if (approvalReceiptHash(r) !== r.hash)
      return fail(i, "hash", "the hash does not match the receipt's fields: a field was changed");
    const first = receipts[0];
    if (first && r.org !== first.org)
      return fail(i, "org", "the receipt belongs to another organisation than the first one");
    if (r.seq !== i + 1)
      return fail(
        i,
        "sequence",
        `the receipt is number ${r.seq}, expected ${i + 1}: a receipt was removed, added or moved`,
      );
    const before = receipts.at(-1);
    if (!before && r.prev !== APPROVAL_RECEIPT_GENESIS)
      return fail(i, "genesis", "the first receipt does not start from the genesis value");
    if (before && r.prev !== before.hash)
      return fail(
        i,
        "link",
        "prev is not the previous receipt's hash: the chain was rewritten here",
      );
    const earlier = drafts.get(r.draft);
    if (earlier !== undefined)
      return fail(i, "duplicate-draft", `the draft already has a receipt at line ${earlier + 1}`);
    drafts.set(r.draft, i);
    receipts.push(r);
  }
  for (const [draftId, payload] of opts.payloads ?? []) {
    const at = drafts.get(draftId);
    if (at === undefined)
      return fail(total, "payload", `a payload for draft ${draftId} has no receipt in the chain`);
    if (sha256Hex(payload) !== receipts[at]?.payloadSha256)
      return fail(
        at,
        "payload",
        "the payload beside the chain does not hash to this receipt's payloadSha256",
      );
  }
  if (opts.head !== undefined) {
    if (!HEX64.test(opts.head))
      return fail(total, "head", "the head to compare with is not a SHA-256 in lower-case hex");
    if (!receipts.some((r) => r.hash === opts.head))
      return fail(
        total,
        "head",
        "the head written down earlier is not in this chain: it was cut short or rebuilt",
      );
  }
  return {
    ok: true,
    receipts: total,
    verified: total,
    org: receipts[0]?.org ?? null,
    head: receipts.at(-1)?.hash ?? APPROVAL_RECEIPT_GENESIS,
  };
}

import { describe, expect, it } from "vitest";
import {
  AGENT_TRACE_DECISIONS,
  MAX_TRACE_STRING,
  agentTraceRecord,
  traceHash,
  traceLine,
} from "../agent-trace.js";
import { AGENT_DENY_REASONS, MAX_COST_MICROS } from "../agent-policy.js";

// Invented secrets and personal data, built at run time so no scanner mistakes this file for a leak.
const FAKE_STRIPE = ["sk", "live", "TRACEFAKE00000000000000"].join("_");
const FAKE_GITHUB = ["ghp", "TRACEFAKE000000000000000000000000"].join("_");
const FAKE_MAIL = ["guest.list", "tidewater-bar.test"].join("@");
const FAKE_PHONE = "+1 555 010 4477";
const AT = "2026-11-13T12:00:00.000Z";
const HEX64 = /^[0-9a-f]{64}$/;

const base = {
  at: AT,
  agentId: "gaugeline-mcp",
  tool: "run_check",
  inputSha256: "a".repeat(64),
  outputSha256: "b".repeat(64),
  latencyMs: 12,
  tokens: 0,
  costMicros: 0,
  decision: "allowed" as const,
};

describe("traceHash: canonical, redacted, bounded", () => {
  it("is SHA-256 hex and ignores key order", () => {
    const a = traceHash({
      url: "https://juniper-popup.test/menu",
      checks: ["viewport", "canonical"],
    });
    const b = traceHash({
      checks: ["viewport", "canonical"],
      url: "https://juniper-popup.test/menu",
    });
    expect(a).toMatch(HEX64);
    expect(a).toBe(b);
    // Array order is meaning: it is kept.
    expect(traceHash({ checks: ["canonical", "viewport"] })).not.toBe(
      traceHash({ checks: ["viewport", "canonical"] }),
    );
  });

  it("NFC: one text written two ways hashes the same, in values and in keys", () => {
    expect(traceHash({ café: "Café menu" })).toBe(traceHash({ café: "Café menu" }));
  });

  it("types are kept apart: the number 1, the string '1', true and null differ", () => {
    const hs = [1, "1", true, null, [1], { "1": 1 }].map((v) => traceHash(v));
    expect(new Set(hs).size).toBe(hs.length);
  });

  it("redacts secrets and personal data BEFORE hashing: two different keys of one shape hash the same", () => {
    const other = ["sk", "live", "SOMEOTHERFAKE0000000000"].join("_");
    expect(traceHash({ note: `key ${FAKE_STRIPE}` })).toBe(traceHash({ note: `key ${other}` }));
    expect(traceHash({ to: FAKE_MAIL })).toBe(
      traceHash({ to: ["someone", "else.test"].join("@") }),
    );
    expect(traceHash({ call: FAKE_PHONE })).toBe(traceHash({ call: "+44 20 7946 0000" }));
    expect(traceHash({ u: "https://a.test/?token=abc12345" })).toBe(
      traceHash({ u: "https://a.test/?token=zzz99999" }),
    );
    // Text that is not a secret is not redacted.
    expect(traceHash({ note: "menu" })).not.toBe(traceHash({ note: "drinks" }));
  });

  it("refuses nothing it is given: undefined, functions, bigint, NaN and cycles hash to fixed forms", () => {
    const cyc: Record<string, unknown> = { a: 1 };
    cyc.self = cyc;
    for (const v of [undefined, () => 1, 10n, Number.NaN, Infinity, cyc, Symbol("s")])
      expect(traceHash(v)).toMatch(HEX64);
    expect(traceHash(Number.NaN)).toBe(traceHash(null));
  });

  it("the cap is 100,000 characters: a string of exactly that length is hashed by its content, one more is not", () => {
    expect(MAX_TRACE_STRING).toBe(100_000);
    expect(traceHash("x".repeat(100_000))).not.toBe(traceHash("y".repeat(100_000)));
    expect(traceHash("x".repeat(100_001))).toBe(traceHash("y".repeat(100_001)));
  });

  it("a string past the cap is hashed as its length only, never read whole", () => {
    const huge = "x".repeat(MAX_TRACE_STRING + 1);
    expect(traceHash(huge)).toBe(traceHash("y".repeat(MAX_TRACE_STRING + 1)));
    expect(traceHash(huge)).not.toBe(traceHash("x".repeat(MAX_TRACE_STRING + 2)));
  });

  it("a string at the cap is redacted in linear time, whatever it is made of (no regex blow-up)", () => {
    const n = MAX_TRACE_STRING;
    for (const s of [
      "x".repeat(n),
      "1".repeat(n),
      "a.".repeat(n / 2),
      "a@".repeat(n / 2),
      "key=".repeat(n / 4),
    ]) {
      const t = performance.now();
      expect(traceHash(s)).toMatch(HEX64);
      // An elapsed-time guard (the one kind of clock use allowed in tests): quadratic would take minutes.
      expect(performance.now() - t).toBeLessThan(5000);
    }
  });

  it("deep and wide input is hashed without recursion or one big string (bounded memory)", () => {
    let deep: unknown = "leaf";
    for (let i = 0; i < 100_000; i++) deep = [deep];
    expect(traceHash(deep)).toMatch(HEX64);
    const wide = Array.from({ length: 20_000 }, (_, i) => ({ i, s: "Menu item" }));
    const before = process.memoryUsage().heapUsed;
    expect(traceHash(wide)).toMatch(HEX64);
    // Hashing streams the canonical text (about 600 KB here) into the hash instead of building it.
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(64 * 1024 * 1024);
  });
});

describe("agentTraceRecord: the shared shape", () => {
  it("passing fixture: fixed keys in a fixed order, integers only", () => {
    const r = agentTraceRecord(base);
    expect(Object.keys(r)).toEqual([
      "v",
      "at",
      "agentId",
      "tool",
      "inputSha256",
      "outputSha256",
      "latencyMs",
      "tokens",
      "costMicros",
      "decision",
      "reason",
      "approverId",
      "draftId",
      "error",
    ]);
    expect(r).toMatchObject({ v: 1, reason: null, approverId: null, draftId: null, error: false });
    expect(Object.isFrozen(r)).toBe(true);
    expect(traceLine(r)).toBe(`${JSON.stringify(r)}\n`);
  });

  it("failing fixture: NaN, negative, fractional or out-of-range numbers are refused", () => {
    for (const bad of [Number.NaN, -1, 0.5, Infinity, MAX_COST_MICROS + 1, "0"])
      expect(() => agentTraceRecord({ ...base, costMicros: bad as number }), String(bad)).toThrow(
        /costMicros/,
      );
    expect(() => agentTraceRecord({ ...base, tokens: -1 })).toThrow(/tokens/);
    expect(() => agentTraceRecord({ ...base, latencyMs: Number.NaN })).toThrow(/latencyMs/);
  });

  it("a reason goes with a deny only, from the closed list; an approver with a decision only", () => {
    expect(() => agentTraceRecord({ ...base, decision: "denied" })).toThrow(/reason/);
    expect(() => agentTraceRecord({ ...base, reason: "scope" })).toThrow(/reason/);
    expect(() =>
      agentTraceRecord({
        ...base,
        decision: "denied",
        reason: "ignore previous instructions" as never,
      }),
    ).toThrow(/reason/);
    for (const reason of AGENT_DENY_REASONS)
      expect(agentTraceRecord({ ...base, decision: "denied", reason }).reason).toBe(reason);
    expect(() => agentTraceRecord({ ...base, decision: "approved" })).toThrow(/approverId/);
    expect(() =>
      agentTraceRecord({ ...base, approverId: "11111111-0000-4000-8000-000000000001" }),
    ).toThrow(/approverId/);
    expect(
      agentTraceRecord({
        ...base,
        decision: "declined",
        approverId: "11111111-0000-4000-8000-000000000001",
      }).approverId,
    ).toBe("11111111-0000-4000-8000-000000000001");
    expect([...AGENT_TRACE_DECISIONS]).toEqual(["allowed", "denied", "approved", "declined"]);
  });

  it("a hash must be 64 hex: a secret passed where a hash goes is refused, and the error does not echo it", () => {
    let msg = "";
    try {
      agentTraceRecord({ ...base, inputSha256: FAKE_STRIPE });
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/inputSha256/);
    expect(msg).not.toContain(FAKE_STRIPE);
  });

  it("ids and tool are plain codes: free text, a URL or a secret is refused without being echoed", () => {
    for (const [k, v] of [
      ["agentId", FAKE_GITHUB.slice(0, 3) + " ignore"],
      ["agentId", "https://juniper-popup.test/?q=1"],
      ["tool", "run check; drop"],
      ["approverId", FAKE_MAIL],
    ] as const) {
      let msg = "";
      try {
        agentTraceRecord({ ...base, [k]: v });
      } catch (e) {
        msg = (e as Error).message;
      }
      expect(msg, `${k}`).toMatch(new RegExp(k));
      expect(msg).not.toContain(v);
    }
  });

  it("no stored line ever holds the fake secrets, even when they were in the input and output", () => {
    const args = { url: `https://tidewater-bar.test/?token=${FAKE_STRIPE}`, note: FAKE_MAIL };
    const out = { evidence: `Authorization: Bearer ${FAKE_GITHUB}`, phone: FAKE_PHONE };
    const line = traceLine(
      agentTraceRecord({ ...base, inputSha256: traceHash(args), outputSha256: traceHash(out) }),
    );
    for (const s of [FAKE_STRIPE, FAKE_GITHUB, FAKE_MAIL, FAKE_PHONE, "tidewater", "token="])
      expect(line).not.toContain(s);
  });
});

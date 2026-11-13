/**
 * The digest agent is registered, limited, traced and evaluated (AG-14): its descriptor holds one read scope
 * and no write tool, its eval set has golden and known-bad cases that run offline, the policy refuses what
 * it was not given, its one read leaves a trace with no text in it, and the docs page shows real output.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  agentTraceRecord,
  createAgentPolicy,
  formatEvalReport,
  isWriteTool,
  runEvals,
  traceHash,
  validateEvalSet,
} from "../../index.js";
import {
  APPROVALS_DIGEST_AGENT,
  approvalsDigestAgent,
  approvalsDigestCases,
  buildApprovalsDigest,
  createApprovalsDigestModel,
  renderApprovalsDigestMarkdown,
} from "../index.js";
import { EXAMPLE_DRAFTS, EXAMPLE_NOW, EXAMPLE_OPTIONS } from "../example.js";

const model = () => createApprovalsDigestModel();
const run = () => runEvals(approvalsDigestAgent, approvalsDigestCases, model());

describe("registered and limited", () => {
  it("asks for one read scope and holds no tool that writes", () => {
    expect(APPROVALS_DIGEST_AGENT.scopes).toEqual(["read:pending"]);
    expect(APPROVALS_DIGEST_AGENT.tools).toEqual(["read:pending"]);
    expect(APPROVALS_DIGEST_AGENT.tools.some(isWriteTool)).toBe(false);
  });

  it("is refused for any tool it was not given, and stops when it is switched off", () => {
    const denied: string[] = [];
    const policy = createAgentPolicy({
      tools: ["read:pending", "draft:email", "read:runs"],
      agents: new Map([
        [
          "approvals-digest",
          { status: "active", tools: ["read:pending"], limits: APPROVALS_DIGEST_AGENT.limits },
        ],
      ]),
      env: {},
      now: () => EXAMPLE_NOW.getTime(),
      onDeny: (e) => denied.push(e.reason),
    });
    const call = (tool: string) =>
      policy.decide({ agentId: "approvals-digest", tool, costMicros: 0 }).allowed;
    expect(call("read:pending")).toBe(true);
    expect(call("draft:email")).toBe(false);
    expect(call("read:runs")).toBe(false);
    expect(denied).toEqual(["scope", "scope"]);
    const off = createAgentPolicy({
      tools: ["read:pending"],
      agents: new Map([
        [
          "approvals-digest",
          { status: "active", tools: ["read:pending"], limits: APPROVALS_DIGEST_AGENT.limits },
        ],
      ]),
      env: { GAUGELINE_AGENTS_OFF: "1" },
    });
    expect(
      off.decide({ agentId: "approvals-digest", tool: "read:pending", costMicros: 0 }).reason,
    ).toBe("kill-switch-global");
  });
});

describe("traced", () => {
  it("leaves a trace of its one read that holds hashes and codes, no draft text", () => {
    const answer = { drafts: EXAMPLE_DRAFTS, nextCursor: null };
    const digest = buildApprovalsDigest(EXAMPLE_DRAFTS, EXAMPLE_NOW, EXAMPLE_OPTIONS);
    const rec = agentTraceRecord({
      at: EXAMPLE_NOW.toISOString(),
      agentId: "approvals-digest",
      tool: "read:pending",
      inputSha256: traceHash({ status: "pending" }),
      outputSha256: traceHash(answer),
      latencyMs: 12,
      tokens: 0,
      costMicros: 0,
      decision: "allowed",
    });
    expect(rec.outputSha256).toMatch(/^[0-9a-f]{64}$/);
    const line = JSON.stringify(rec);
    for (const d of digest.attention) expect(line).not.toContain(d.title);
  });
});

describe("evaluated", () => {
  it("is a valid eval set with golden and known-bad cases", () => {
    expect(validateEvalSet(approvalsDigestAgent, approvalsDigestCases)).toEqual([]);
    const kinds = approvalsDigestCases.map((c) => c.kind);
    expect(kinds.filter((k) => k === "golden").length).toBe(3);
    expect(kinds.filter((k) => k === "known-bad").length).toBe(7);
  });

  it("passes every golden case, running the real digest code", async () => {
    const report = await run();
    expect(report.results.filter((r) => r.kind === "golden").map((r) => r.status)).toEqual([
      "pass",
      "pass",
      "pass",
    ]);
  });

  it("catches every known-bad case with the assertion written for it", async () => {
    const report = await run();
    const caught = Object.fromEntries(
      report.results
        .filter((r) => r.kind === "known-bad")
        .map((r) => [
          r.caseId,
          [r.status, ...r.assertions.filter((a) => a.status === "fail").map((a) => a.id)],
        ]),
    );
    expect(caught).toEqual({
      "bad-missing-id": ["caught", "cited-ids"],
      "bad-invented-number": ["caught", "no-invented-numbers"],
      "bad-write-call": ["caught", "no-write-call"],
      "bad-over-cost": ["caught", "limits"],
      "bad-too-slow": ["caught", "limits"],
      "bad-oversized-input": ["caught", "limits"],
      "bad-malformed-output": ["caught", "schema"],
    });
    expect(report.ok).toBe(true);
    expect(report.costMicros).toBe(60_000);
  });

  it("a recording for a golden case cannot stand in for the real code", async () => {
    // The model computes golden answers and replays only known-bad ones: no recording can hide a regression.
    const m = createApprovalsDigestModel();
    const out = await m.complete({
      caseId: "golden-morning-mix",
      agentId: "approvals-digest",
      prompt: "",
    });
    expect(out.usage.costMicros).toBe(0);
    expect(JSON.parse(out.text).totals.pending).toBe(4);
    await expect(
      m.complete({ caseId: "no-such-case", agentId: "approvals-digest", prompt: "" }),
    ).rejects.toThrow(/No recording/);
  });

  it("holds the hostile draft as data: its order is in the output as a title, nothing is called", async () => {
    const r = (await run()).results.find((x) => x.caseId === "golden-hostile-draft-is-data")!;
    expect(r.status).toBe("pass");
    expect(r.assertions.find((a) => a.id === "no-write-call")!.status).toBe("pass");
  });
});

describe("the docs page", () => {
  const page = readFileSync(
    fileURLToPath(new URL("../../../../../docs/approvals-digest.md", import.meta.url)),
    "utf8",
  );
  const block = (title: string) =>
    new RegExp("```(?:text|md|markdown)? title=" + title + "\\n([\\s\\S]*?)\\n```").exec(page)?.[1];

  it("shows the digest this code writes, word for word", () => {
    const md = renderApprovalsDigestMarkdown(
      buildApprovalsDigest(EXAMPLE_DRAFTS, EXAMPLE_NOW, EXAMPLE_OPTIONS),
    );
    expect(block("Output")).toBe(md.trimEnd());
  });

  it("shows the eval report this code prints, word for word", async () => {
    expect(block("Evals")).toBe(formatEvalReport(await run()));
  });
});

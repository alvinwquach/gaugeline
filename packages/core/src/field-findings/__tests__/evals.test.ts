/**
 * The miner is registered, limited, traced and evaluated (AG-15): its descriptor holds one local read and no
 * tool that writes, its eval set has golden and known-bad cases that run offline, the policy refuses what it was
 * not given, its one read leaves a trace with no note text in it, and the docs page shows real output.
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
  FIELD_FINDINGS_MINER_AGENT,
  KNOWN_BAD_NOTES,
  NotesInputError,
  createFieldFindingsModel,
  fieldFindingsCases,
  fieldFindingsMinerAgent,
  mineFieldFindings,
  renderFieldFindingsMarkdown,
} from "../index.js";
import { EXAMPLE_DENY_LIST, EXAMPLE_NOTES } from "../example.js";

const run = () => runEvals(fieldFindingsMinerAgent, fieldFindingsCases, createFieldFindingsModel());
const NOW = Date.UTC(2026, 10, 13, 12, 0, 0);

describe("registered and limited", () => {
  it("is one local read: no hosted scope, and no tool that writes", () => {
    expect(FIELD_FINDINGS_MINER_AGENT.tools).toEqual(["read:notes"]);
    expect(FIELD_FINDINGS_MINER_AGENT.scopes).toEqual([]);
    expect(FIELD_FINDINGS_MINER_AGENT.tools.some(isWriteTool)).toBe(false);
  });

  it("is refused for any tool it was not given, and stops when it is switched off", () => {
    const rule = {
      status: "active" as const,
      tools: ["read:notes"],
      limits: FIELD_FINDINGS_MINER_AGENT.limits,
    };
    const agents = new Map([["field-findings-miner", rule]]);
    const denied: string[] = [];
    const policy = createAgentPolicy({
      tools: ["read:notes", "draft:email", "read:pending"],
      agents,
      env: {},
      now: () => NOW,
      onDeny: (e) => denied.push(e.reason),
    });
    const call = (tool: string) =>
      policy.decide({ agentId: "field-findings-miner", tool, costMicros: 0 }).allowed;
    expect(call("read:notes")).toBe(true);
    expect(call("draft:email")).toBe(false);
    expect(call("read:pending")).toBe(false);
    expect(denied).toEqual(["scope", "scope"]);
    const off = createAgentPolicy({
      tools: ["read:notes"],
      agents,
      env: { GAUGELINE_AGENTS_OFF: "1" },
    });
    expect(
      off.decide({ agentId: "field-findings-miner", tool: "read:notes", costMicros: 0 }).reason,
    ).toBe("kill-switch-global");
  });
});

describe("traced", () => {
  it("leaves a trace of its one read that holds hashes and codes, no note text", () => {
    const r = mineFieldFindings(EXAMPLE_NOTES, { denyList: EXAMPLE_DENY_LIST });
    if (!r.ok) throw new Error("expected a draft");
    const rec = agentTraceRecord({
      at: new Date(NOW).toISOString(),
      agentId: "field-findings-miner",
      tool: "read:notes",
      inputSha256: traceHash({ notes: EXAMPLE_NOTES.length }),
      outputSha256: traceHash(r.draft),
      latencyMs: 4,
      tokens: 0,
      costMicros: 0,
      decision: "allowed",
    });
    expect(rec.outputSha256).toMatch(/^[0-9a-f]{64}$/);
    const line = JSON.stringify(rec);
    for (const c of r.draft.candidates) expect(line).not.toContain(c.summary);
    for (const n of EXAMPLE_NOTES) expect(line).not.toContain(n.name);
  });
});

describe("evaluated", () => {
  it("is a valid eval set with golden and known-bad cases", () => {
    expect(validateEvalSet(fieldFindingsMinerAgent, fieldFindingsCases)).toEqual([]);
    const kinds = fieldFindingsCases.map((c) => c.kind);
    expect(kinds.filter((k) => k === "golden").length).toBe(3);
    expect(kinds.filter((k) => k === "known-bad").length).toBe(10);
  });

  it("passes every golden case, running the real miner", async () => {
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
      "bad-missing-pattern": ["caught", "cited-ids"],
      "bad-invented-number": ["caught", "no-invented-numbers"],
      "bad-obeys-note": ["caught", "no-write-call"],
      "bad-client-name": ["caught", "schema"],
      "bad-web-address": ["caught", "schema"],
      "bad-email-and-phone": ["caught", "schema"],
      "bad-over-cost": ["caught", "limits"],
      "bad-too-slow": ["caught", "limits"],
      "bad-oversized-file": ["caught", "limits"],
      "bad-malformed-notes": ["caught", "schema"],
    });
    expect(report.ok).toBe(true);
    expect(report.costMicros).toBe(60_000);
  });

  it("a schema failure for a leak names the kind and the path, never the value", async () => {
    const report = await run();
    const r = report.results.find((x) => x.caseId === "bad-client-name")!;
    const detail = r.assertions.find((a) => a.id === "schema")!.detail ?? "";
    expect(detail).toMatch(/name/);
    expect(JSON.stringify(report)).not.toMatch(
      /Tidewater|Juniper|Northgate|chef@|7946|menu\.example/i,
    );
  });

  it("the real miner refuses or ignores each known-bad set of notes, so the evals are not only recordings", () => {
    const deny = { denyList: EXAMPLE_DENY_LIST };
    expect(mineFieldFindings(KNOWN_BAD_NOTES.get("bad-client-name")!, deny)).toMatchObject({
      ok: false,
    });
    expect(mineFieldFindings(KNOWN_BAD_NOTES.get("bad-web-address")!, deny)).toMatchObject({
      ok: false,
    });
    expect(mineFieldFindings(KNOWN_BAD_NOTES.get("bad-email-and-phone")!, deny)).toMatchObject({
      ok: false,
    });
    const hostile = mineFieldFindings(KNOWN_BAD_NOTES.get("bad-obeys-note")!, deny);
    expect(hostile.ok && hostile.draft.notProposed.instructionLines).toBe(1);
    expect(hostile.ok && JSON.stringify(hostile.draft)).not.toMatch(/publish_check/);
    expect(() => mineFieldFindings(KNOWN_BAD_NOTES.get("bad-oversized-file")!, deny)).toThrow(
      NotesInputError,
    );
    expect(() => mineFieldFindings(KNOWN_BAD_NOTES.get("bad-malformed-notes")!, deny)).toThrow(
      NotesInputError,
    );
  });

  it("a recording for a golden case cannot stand in for the real code", async () => {
    const m = createFieldFindingsModel();
    const out = await m.complete({
      caseId: "golden-recurring-patterns",
      agentId: "field-findings-miner",
      prompt: "",
    });
    expect(out.usage.costMicros).toBe(0);
    expect(JSON.parse(out.text).candidates).toHaveLength(3);
    await expect(
      m.complete({ caseId: "no-such-case", agentId: "field-findings-miner", prompt: "" }),
    ).rejects.toThrow(/No recording/);
  });

  it("holds the hostile note as data: nothing is called and the order is not in the draft", async () => {
    const r = (await run()).results.find((x) => x.caseId === "golden-hostile-note-is-data")!;
    expect(r.status).toBe("pass");
    expect(r.assertions.find((a) => a.id === "no-write-call")!.status).toBe("pass");
  });
});

describe("the docs page", () => {
  const page = readFileSync(
    fileURLToPath(new URL("../../../../../docs/field-findings-miner.md", import.meta.url)),
    "utf8",
  ).replace(/\r\n/g, "\n");
  // The draft holds fenced examples of its own, so it sits in a four-backtick fence.
  const block = (title: string, fence = "```") =>
    new RegExp(
      `${fence}(?:text|md|markdown)? title="?${title}"?\\n([\\s\\S]*?)\\n${fence}\\n`,
    ).exec(page)?.[1];

  it("shows the draft this code writes, word for word", () => {
    const r = mineFieldFindings(EXAMPLE_NOTES, { denyList: EXAMPLE_DENY_LIST });
    if (!r.ok) throw new Error("expected a draft");
    expect(block("Draft", "````")).toBe(renderFieldFindingsMarkdown(r.draft).trimEnd());
  });

  it("shows the eval report this code prints, word for word", async () => {
    expect(block("Evals")).toBe(formatEvalReport(await run()));
  });
});

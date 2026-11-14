/**
 * The house-rules compiler is registered, limited, traced and evaluated (AG-17): its descriptor holds no scope
 * and no write tool, its eval set has golden and known-bad cases that run offline (an injection line, an
 * oversized file, an unsafe pattern, an absolute path, malformed output), the policy refuses what it was not
 * given, its one read leaves a trace with no rule text in it, and the docs page shows real output.
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
  HOUSE_RULES_AGENT,
  HOUSE_DRAFT_FILE,
  compileHouseRules,
  createHouseRulesModel,
  houseRulesAgent,
  houseRulesCases,
  renderHouseDraftJson,
  renderHouseRulesReview,
} from "../index.js";
import { EXAMPLE_NOW, EXAMPLE_STYLE_GUIDE } from "../example.js";

const run = () => runEvals(houseRulesAgent, houseRulesCases, createHouseRulesModel());

describe("registered and limited", () => {
  it("asks for one scope, read:rules-file, and holds one read tool and none that writes", () => {
    expect(HOUSE_RULES_AGENT.scopes).toEqual(["read:rules-file"]);
    expect(HOUSE_RULES_AGENT.tools).toEqual(["read:rules-file"]);
    expect(HOUSE_RULES_AGENT.tools.some(isWriteTool)).toBe(false);
    expect(HOUSE_RULES_AGENT.id).toBe("house-rules-compiler");
  });

  it("is refused for any tool it was not given, and stops when it is switched off", () => {
    const denied: string[] = [];
    const agents = new Map([
      [
        "house-rules-compiler",
        {
          status: "active" as const,
          tools: HOUSE_RULES_AGENT.tools,
          limits: HOUSE_RULES_AGENT.limits,
        },
      ],
    ]);
    const policy = createAgentPolicy({
      tools: ["read:rules-file", "draft:email", "read:pending"],
      agents,
      env: {},
      now: () => EXAMPLE_NOW.getTime(),
      onDeny: (e) => denied.push(e.reason),
    });
    const call = (tool: string) =>
      policy.decide({ agentId: "house-rules-compiler", tool, costMicros: 0 }).allowed;
    expect(call("read:rules-file")).toBe(true);
    expect(call("draft:email")).toBe(false);
    expect(call("read:pending")).toBe(false);
    expect(denied).toEqual(["scope", "scope"]);
    const off = createAgentPolicy({
      tools: ["read:rules-file"],
      agents,
      env: { GAUGELINE_AGENTS_OFF: "1" },
    });
    expect(
      off.decide({ agentId: "house-rules-compiler", tool: "read:rules-file", costMicros: 0 })
        .reason,
    ).toBe("kill-switch-global");
  });
});

describe("traced", () => {
  it("leaves a trace of its one read that holds hashes and codes, no rule text", () => {
    const draft = compileHouseRules(EXAMPLE_STYLE_GUIDE);
    const rec = agentTraceRecord({
      at: EXAMPLE_NOW.toISOString(),
      agentId: "house-rules-compiler",
      tool: "read:rules-file",
      inputSha256: traceHash(EXAMPLE_STYLE_GUIDE),
      outputSha256: traceHash(draft.config),
      latencyMs: 3,
      tokens: 0,
      costMicros: 0,
      decision: "allowed",
    });
    expect(rec.inputSha256).toMatch(/^[0-9a-f]{64}$/);
    const line = JSON.stringify(rec);
    expect(line).not.toContain("Book now");
    expect(line).not.toContain("cheap");
  });
});

describe("evaluated", () => {
  it("is a valid eval set with golden and known-bad cases", () => {
    expect(validateEvalSet(houseRulesAgent, houseRulesCases)).toEqual([]);
    const kinds = houseRulesCases.map((c) => c.kind);
    expect(kinds.filter((k) => k === "golden").length).toBe(6);
    expect(kinds.filter((k) => k === "known-bad").length).toBe(10);
  });

  it("passes every golden case, running the real compiler", async () => {
    const report = await run();
    expect(report.results.filter((r) => r.kind === "golden").map((r) => r.status)).toEqual(
      Array(6).fill("pass"),
    );
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
      "bad-missing-line": ["caught", "cited-ids"],
      "bad-invented-number": ["caught", "no-invented-numbers"],
      "bad-obeys-injection": ["caught", "no-write-call"],
      "bad-unsafe-pattern": ["caught", "schema"],
      "bad-absolute-path": ["caught", "schema"],
      "bad-guessed-key": ["caught", "schema"],
      "bad-over-cost": ["caught", "limits"],
      "bad-too-slow": ["caught", "limits"],
      "bad-oversized-file": ["caught", "limits"],
      "bad-malformed-output": ["caught", "schema"],
    });
    expect(report.ok).toBe(true);
    expect(report.costMicros).toBe(60_000);
  });

  it("a recording for a golden case cannot stand in for the real code", async () => {
    const m = createHouseRulesModel();
    const out = await m.complete({
      caseId: "golden-style-guide",
      agentId: "house-rules-compiler",
      prompt: "",
    });
    expect(out.usage.costMicros).toBe(0);
    expect(JSON.parse(out.text).config.buttonLabel).toBe("Book now");
    await expect(
      m.complete({ caseId: "no-such-case", agentId: "house-rules-compiler", prompt: "" }),
    ).rejects.toThrow(/No recording/);
  });

  it("holds the injection line as data: it is listed and cited, and nothing is called", async () => {
    const r = (await run()).results.find((x) => x.caseId === "golden-injection-line")!;
    expect(r.status).toBe("pass");
    expect(r.assertions.find((a) => a.id === "no-write-call")!.status).toBe("pass");
    expect(r.assertions.find((a) => a.id === "must-cite")!.status).toBe("pass");
  });
});

describe("the docs page", () => {
  const page = readFileSync(
    fileURLToPath(new URL("../../../../../docs/house-rules.md", import.meta.url)),
    "utf8",
  );
  const block = (title: string) =>
    new RegExp("```[a-z]* title=" + title + "\\n([\\s\\S]*?)\\n```").exec(page)?.[1];

  it("shows the rules file, the review and the draft this code writes, word for word", () => {
    const draft = compileHouseRules(EXAMPLE_STYLE_GUIDE);
    expect(block("gaugeline-house-style.md")).toBe(EXAMPLE_STYLE_GUIDE.trimEnd());
    expect(block("Output")).toBe(
      renderHouseRulesReview(draft, { draftFile: HOUSE_DRAFT_FILE }).trimEnd(),
    );
    expect(block("gaugeline.rules.draft.json")).toBe(renderHouseDraftJson(draft).trimEnd());
  });

  it("shows the eval report this code prints, word for word", async () => {
    expect(block("Evals")).toBe(formatEvalReport(await run()));
  });
});

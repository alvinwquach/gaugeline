/**
 * AG-22 end to end, with the recorded fake only: a ledger's hooks inside the gateway stop a call before the
 * adapter is reached, the gateway's token estimate is the estimate's, a failed call stays counted, a spend
 * becomes a valid trace record, and the docs page shows what the code prints.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { agentTraceRecord } from "../../agent-trace.js";
import { scan } from "../../__tests__/post-scan.js";
import { runBudgetExample } from "../budget-example.js";
import {
  callCostMicros,
  createBudgetLedger,
  estimateInputTokens,
  estimateRun,
  traceFieldsOf,
  type SpendEntry,
} from "../budget.js";
import { ModelGatewayError } from "../errors.js";
import { createGateway } from "../gateway.js";
import { RECORDED_PROVIDER, createRecordedAdapter } from "../recorded.js";
import type { BudgetEstimate, ModelAdapter } from "../types.js";

const BUDGET = {
  ceilings: { perRunMicros: 3_000, perDayMicros: 10_000, perWorkspaceMicros: 100_000 },
  prices: { "word-small": { inputMicrosPerMTok: 250_000, outputMicrosPerMTok: 1_250_000 } },
};
const NOON = Date.UTC(2026, 10, 13, 12, 0, 0);
const ANSWER = {
  text: "ok",
  usage: { inputTokens: 1_800, outputTokens: 200, costMicros: 0, latencyMs: 5 },
};
const PROMPT = "a".repeat(8_000);

function build(opts: { adapter?: ModelAdapter; onSpend?: (e: SpendEntry) => void } = {}) {
  const ledger = createBudgetLedger({
    config: BUDGET,
    now: () => NOON,
    ...(opts.onSpend ? { onSpend: opts.onSpend } : {}),
  });
  const run = ledger.forRun("workspace-a");
  const seen: string[] = [];
  const adapter: ModelAdapter = opts.adapter ?? {
    provider: RECORDED_PROVIDER,
    needsKey: false,
    async complete(call) {
      seen.push(call.callId);
      return ANSWER;
    },
  };
  const gateway = createGateway({
    config: { provider: RECORDED_PROVIDER, tiers: { fast: "word-small" } },
    adapters: [adapter],
    env: () => ({}),
    budget: run,
  });
  return { ledger, run, gateway, seen };
}
const ask = (g: ReturnType<typeof build>["gateway"], callId: string, prompt = PROMPT) =>
  g.complete({ tier: "fast", agentId: "triage", callId, prompt });

describe("a ledger's hooks inside the gateway", () => {
  it("lets calls through while they fit, and stops the one that could pass the ceiling before the adapter", async () => {
    const { gateway, seen, run } = build();
    await ask(gateway, "a");
    await ask(gateway, "b");
    expect(run.committedMicros()).toBe(1_400);
    const err = await ask(gateway, "c").catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ModelGatewayError);
    expect((err as ModelGatewayError).code).toBe("budget");
    expect((err as ModelGatewayError).message).toContain("per-run ceiling of 3000");
    expect(seen).toEqual(["a", "b"]);
  });

  it("stays stopped: a tiny prompt is refused after the first refusal, and no adapter is reached", async () => {
    const { gateway, seen } = build();
    await ask(gateway, "a");
    await ask(gateway, "b");
    await ask(gateway, "c").catch(() => undefined);
    const err = await ask(gateway, "d", "Hi").catch((e: unknown) => e);
    expect((err as ModelGatewayError).code).toBe("budget");
    expect(seen).toEqual(["a", "b"]);
  });

  it("hands the budget the same token count the plan's estimate uses", async () => {
    const asked: BudgetEstimate[] = [];
    const ledger = createBudgetLedger({ config: BUDGET, now: () => NOON });
    const run = ledger.forRun("workspace-a");
    const gateway = createGateway({
      config: { provider: RECORDED_PROVIDER, tiers: { fast: "word-small" } },
      adapters: [createRecordedAdapter(new Map([["a", ANSWER]]))],
      env: () => ({}),
      budget: {
        before: (e) => (asked.push(e), run.before(e)),
        after: (e) => run.after(e),
      },
    });
    await ask(gateway, "a");
    const planned = estimateRun(BUDGET, [
      { tier: "fast", model: "word-small", inputChars: PROMPT.length, maxOutputTokens: 1_024 },
    ]);
    expect(asked[0]!.inputTokens).toBe(estimateInputTokens(PROMPT.length));
    expect(asked[0]!.callId).toBe("a");
    expect(planned.ok && planned.calls[0]!.inputTokens).toBe(asked[0]!.inputTokens);
    // The gateway's output limit (1024 by default) is what the worst case used.
    expect(planned.ok && planned.costMicros).toBe(
      callCostMicros(BUDGET.prices["word-small"], 2_000, 1_024),
    );
  });

  it("keeps a call that failed counted at its worst case: the provider may have billed it", async () => {
    const failing: ModelAdapter = {
      provider: RECORDED_PROVIDER,
      needsKey: false,
      async complete() {
        throw new Error("connection reset");
      },
    };
    const { gateway, run } = build({ adapter: failing });
    await ask(gateway, "a").catch(() => undefined);
    expect(run.committedMicros()).toBe(1_780);
  });

  it("makes a spend that is a valid trace record, so the scorecard has a measured cost", async () => {
    const spent: SpendEntry[] = [];
    const { gateway } = build({ onSpend: (e) => spent.push(e) });
    await ask(gateway, "a");
    expect(spent).toHaveLength(1);
    const rec = agentTraceRecord({
      at: "2026-11-13T12:00:00Z",
      agentId: "triage",
      tool: "model:complete",
      inputSha256: null,
      outputSha256: null,
      latencyMs: 5,
      ...traceFieldsOf(spent[0]!),
      decision: "allowed",
    });
    expect(rec.tokens).toBe(2_000);
    expect(rec.costMicros).toBe(700);
  });

  it("runs with no network, no key and no real clock", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("network used");
    });
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("clock used");
    });
    const { gateway } = build();
    await expect(ask(gateway, "a")).resolves.toBeDefined();
    now.mockRestore();
    vi.unstubAllGlobals();
  });
});

describe("this change has no network code and no provider SDK", () => {
  const dir = fileURLToPath(new URL("..", import.meta.url));
  const files = readdirSync(dir).filter((n) => n.startsWith("budget") && n.endsWith(".ts"));

  it("finds the budget files", () => {
    expect(files).toEqual(
      expect.arrayContaining(["budget.ts", "budget-config.ts", "budget-example.ts"]),
    );
  });

  it("builds no request, opens no connection and reads neither the environment nor the real clock", () => {
    for (const f of files) {
      const text = readFileSync(join(dir, f), "utf8");
      expect(scan(`core/src/model-gateway/${f}`, text), f).toEqual([]);
      expect(text, f).not.toMatch(/process\s*\.\s*env|process\[|Date\.now|new Date\(\)/);
    }
  });
});

describe("the docs page", () => {
  const page = readFileSync(
    fileURLToPath(new URL("../../../../../docs/model-budgets.md", import.meta.url)),
    "utf8",
  );
  const block = (title: string) =>
    new RegExp("```(?:text|ts)? title=" + title + "\\n([\\s\\S]*?)\\n```").exec(page)?.[1];

  it("shows the output this code prints, word for word", async () => {
    expect(block("Output")).toBe(await runBudgetExample());
  });

  it("shows code that is the example's own: every line of it is in budget-example.ts", () => {
    const source = readFileSync(
      fileURLToPath(new URL("../budget-example.ts", import.meta.url)),
      "utf8",
    );
    const shown = (block("Example") ?? "")
      .replace(/^import[\s\S]*?;\n/, "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("import ") && !l.startsWith("console.log"));
    expect(shown.length).toBeGreaterThan(20);
    for (const line of shown) expect(source, line).toContain(line);
  });

  it("shows the config as the config schema reads it", async () => {
    const json = /```json\n([\s\S]*?)\n```/.exec(page)?.[1];
    const { parseBudgetConfig } = await import("../budget-config.js");
    expect(parseBudgetConfig(JSON.parse(json ?? "null")).ok).toBe(true);
  });
});

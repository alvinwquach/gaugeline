/**
 * AG-24 end to end, offline: a gateway is built only from a config the pins allow, a model changed without a
 * matching eval pass never gets a gateway, the module has no I/O, and the docs page shows what the code prints.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { scan } from "../../__tests__/post-scan.js";
import { CouldNotRunError } from "../../errors.js";
import { createReplayModel } from "../../evals/replay.js";
import { defineEvalSet } from "../../evals/sets.js";
import { triage } from "../../evals/example/triage.js";
import { runEvalSets } from "../../evals/suite.js";
import { createGateway } from "../gateway.js";
import { parseModelPins, reportSha256, requireEvaluatedModels } from "../model-pins.js";
import { runModelPinsExample } from "../model-pins-example.js";
import { RECORDED_PROVIDER, createRecordedAdapter } from "../recorded.js";

const here = (p: string) => fileURLToPath(new URL(p, import.meta.url));
const AGENTS = ["triage"];
const answers = new Map([
  [
    "note-1",
    { text: "ok", usage: { inputTokens: 1, outputTokens: 1, costMicros: 1, latencyMs: 1 } },
  ],
]);

async function setup() {
  const set = defineEvalSet({
    agent: triage.agent,
    cases: triage.cases,
    model: () => createReplayModel(triage.recordings),
  });
  const report = `${JSON.stringify(await runEvalSets([set]), null, 2)}\n`;
  const tiers = { fast: "recorded-small", strong: "recorded-large" };
  const pins = (over: object = {}) =>
    JSON.stringify({
      schema: 1,
      provider: RECORDED_PROVIDER,
      tiers,
      evalPass: { tiers, reportSha256: reportSha256(report) },
      ...over,
    });
  const gatewayFor = (config: { provider: string; tiers: Record<string, string> }, p: string) =>
    createGateway({
      config: requireEvaluatedModels({
        config: config as never,
        pinsText: p,
        reportText: report,
        agents: AGENTS,
      }),
      adapters: [createRecordedAdapter(answers)],
      env: () => ({}),
    });
  return { report, tiers, pins, gatewayFor };
}

describe("a gateway only from evaluated models", () => {
  it("is built and answers when the config is the pinned, evaluated one", async () => {
    const { tiers, pins, gatewayFor } = await setup();
    const g = gatewayFor({ provider: RECORDED_PROVIDER, tiers }, pins());
    const a = await g.complete({ tier: "fast", agentId: "triage", callId: "note-1", prompt: "Hi" });
    expect(a.model).toBe("recorded-small");
  });

  it("is never built for a model changed without a recorded pass", async () => {
    const { tiers, pins, gatewayFor } = await setup();
    const newer = { ...tiers, fast: "recorded-small-v2" };
    const change = () =>
      gatewayFor({ provider: RECORDED_PROVIDER, tiers: newer }, pins({ tiers: newer }));
    expect(change).toThrow(CouldNotRunError);
    expect(change).toThrow(
      /\[not on the known list\] but the recorded eval pass was for recorded-small/,
    );
  });

  it("is built again once the pass is recorded for the new model", async () => {
    const { tiers, pins, gatewayFor, report } = await setup();
    const newer = { ...tiers, fast: "recorded-small-v2" };
    const p = pins({
      tiers: newer,
      evalPass: { tiers: newer, reportSha256: reportSha256(report) },
    });
    expect(() => gatewayFor({ provider: RECORDED_PROVIDER, tiers: newer }, p)).not.toThrow();
  });

  it("runs with no network, no key and no real clock", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("network used");
    });
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("clock used");
    });
    const { tiers, pins, gatewayFor } = await setup();
    expect(() => gatewayFor({ provider: RECORDED_PROVIDER, tiers }, pins())).not.toThrow();
    now.mockRestore();
    vi.unstubAllGlobals();
  });
});

describe("this change has no I/O of its own", () => {
  for (const f of ["model-pins.ts", "model-pins-example.ts"]) {
    const text = readFileSync(here(`../${f}`), "utf8");
    it(`${f} builds no request, reads no file, no environment and no real clock`, () => {
      expect(scan(`core/src/model-gateway/${f}`, text)).toEqual([]);
      expect(text).not.toMatch(/process\s*\.\s*env|process\[|Date\.now|new Date\(\)|node:fs/);
    });
  }
});

describe("the docs page", () => {
  const page = readFileSync(here("../../../../../docs/model-pins.md"), "utf8");
  const block = (title: string) =>
    new RegExp("```(?:text|ts)? title=" + title + "\\n([\\s\\S]*?)\\n```").exec(page)?.[1];

  it("shows the output this code prints, word for word", async () => {
    expect(block("Output")).toBe(await runModelPinsExample());
  });

  it("shows code that is the example's own: every line of it is in model-pins-example.ts", () => {
    const source = readFileSync(here("../model-pins-example.ts"), "utf8");
    const shown = (block("Example") ?? "")
      .replace(/^(import[\s\S]*?;\n)+/, "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("import ") && !l.startsWith("console.log"));
    expect(shown.length).toBeGreaterThan(15);
    for (const line of shown) expect(source, line).toContain(line);
  });

  it("shows a pins file the schema reads (with a real hash in place of the placeholder)", () => {
    const json = /```json\n([\s\S]*?)\n```/.exec(page)?.[1] ?? "null";
    const filled = json.replace(/<[^>]*>/, "a".repeat(64));
    expect(parseModelPins(JSON.parse(filled)).ok).toBe(true);
  });
});

/**
 * AG-19 end to end, with the recorded fake only: the AG-09 eval harness runs an agent through the gateway and
 * gets the report it gets from the replay itself; a gateway failure is a case error, never a pass; the module
 * has no network code; and the docs page shows what the code prints.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { triage } from "../../evals/example/triage.js";
import { createReplayModel } from "../../evals/replay.js";
import { formatEvalReport, runEvals } from "../../evals/run.js";
import { scan } from "../../__tests__/post-scan.js";
import { gatewayEvalModel } from "../eval-bridge.js";
import { runExample } from "../example.js";
import { createGateway } from "../gateway.js";
import { RECORDED_PROVIDER, createRecordedAdapter } from "../recorded.js";

const CONFIG = {
  provider: RECORDED_PROVIDER,
  tiers: { fast: "recorded-small", strong: "recorded-large" },
  timeoutMs: 5_000,
  maxInputChars: 100_000,
  maxOutputTokens: 1_024,
};
const through = (recordings = triage.recordings) =>
  gatewayEvalModel(
    createGateway({
      config: CONFIG,
      adapters: [createRecordedAdapter(recordings)],
      env: () => ({}),
    }),
    "fast",
  );

describe("the eval harness through the gateway", () => {
  it("gives the report the replay itself gives, byte for byte, with the same cost", async () => {
    const direct = await runEvals(triage.agent, triage.cases, createReplayModel(triage.recordings));
    const viaGateway = await runEvals(triage.agent, triage.cases, through());
    expect(JSON.stringify(viaGateway)).toBe(JSON.stringify(direct));
    expect(viaGateway.ok).toBe(true);
    expect(viaGateway.costMicros).toBe(1_008_000);
  });

  it("makes a case with no recording an error with the gateway's words, never a pass", async () => {
    const some = new Map([...triage.recordings].filter(([id]) => id !== "golden-two-causes"));
    const report = await runEvals(triage.agent, triage.cases, through(some));
    const c = report.results.find((r) => r.caseId === "golden-two-causes")!;
    expect(c.status).toBe("error");
    expect(c.detail).toContain("golden-two-causes");
    expect(report.ok).toBe(false);
  });

  it("passes the agent's id and the case id to the gateway, and the tier it was built with", async () => {
    const seen: string[] = [];
    const g = createGateway({
      config: CONFIG,
      adapters: [
        {
          provider: RECORDED_PROVIDER,
          needsKey: false,
          async complete(call) {
            seen.push(`${call.model}:${call.callId}`);
            return createRecordedAdapter(triage.recordings).complete(call);
          },
        },
      ],
      env: () => ({}),
    });
    await runEvals(triage.agent, triage.cases, gatewayEvalModel(g, "strong"));
    expect(seen[0]).toBe(`recorded-large:${triage.cases[0]!.id}`);
    expect(seen.every((s) => s.startsWith("recorded-large:"))).toBe(true);
  });

  it("runs with no network, no key and no real clock", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("network used");
    });
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("clock used");
    });
    vi.stubEnv("EXAMPLE_API_KEY", "");
    expect((await runEvals(triage.agent, triage.cases, through())).ok).toBe(true);
    now.mockRestore();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });
});

describe("this change has no network code and no provider SDK", () => {
  const dir = fileURLToPath(new URL("..", import.meta.url));
  const files = readdirSync(dir).filter((n) => n.endsWith(".ts"));

  it("finds the module's files", () => {
    expect(files).toEqual(
      expect.arrayContaining(["gateway.ts", "recorded.ts", "config.ts", "key.ts", "types.ts"]),
    );
  });

  it("builds no request, opens no connection and imports no HTTP client (the same scan as the boundary test)", () => {
    for (const f of files)
      expect(scan(`core/src/model-gateway/${f}`, readFileSync(join(dir, f), "utf8")), f).toEqual(
        [],
      );
  });

  it("never reads the process environment: the caller hands the environment in", () => {
    for (const f of files)
      expect(readFileSync(join(dir, f), "utf8"), f).not.toMatch(/process\s*\.\s*env|process\[/);
  });
});

describe("the docs page", () => {
  const page = readFileSync(
    fileURLToPath(new URL("../../../../../docs/model-gateway.md", import.meta.url)),
    "utf8",
  );
  const block = (title: string) =>
    new RegExp("```(?:text|ts)? title=" + title + "\\n([\\s\\S]*?)\\n```").exec(page)?.[1];

  it("shows the output this code prints, word for word", async () => {
    expect(block("Output")).toBe(await runExample());
  });

  it("shows code that is the example's own: every line of it is in example.ts", () => {
    const source = readFileSync(fileURLToPath(new URL("../example.ts", import.meta.url)), "utf8");
    const shown = (block("Example") ?? "")
      .replace(/^import[\s\S]*?;\n/, "")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l !== "" && !l.startsWith("import ") && !l.startsWith("console.log"));
    expect(shown.length).toBeGreaterThan(5);
    for (const line of shown) expect(source, line).toContain(line);
  });

  it("shows the eval report the harness prints through the gateway, word for word", async () => {
    expect(block("Evals")).toBe(
      formatEvalReport(await runEvals(triage.agent, triage.cases, through())),
    );
  });
});

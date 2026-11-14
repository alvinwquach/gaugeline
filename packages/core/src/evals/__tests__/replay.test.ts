/**
 * The replay model (AG-09): a recorded fake keyed by case id. It looks a recording up and nothing else.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { EvalReplayError, createReplayModel, parseRecording } from "../replay.js";
import type { EvalRecording } from "../types.js";

const usage = { inputTokens: 100, outputTokens: 20, costMicros: 1500, latencyMs: 300 };
const good: EvalRecording = { text: '{"groups":[]}', usage };
const req = (caseId: string) => ({ caseId, agentId: "t", prompt: "p" });

afterEach(() => vi.unstubAllGlobals());

describe("createReplayModel", () => {
  it("returns the recording for the case id, the same every time", async () => {
    const m = createReplayModel(new Map([["case-a", good]]));
    expect(await m.complete(req("case-a"))).toEqual(good);
    expect(await m.complete(req("case-a"))).toEqual(good);
  });
  it("hands out a copy: changing one answer does not change the recording", async () => {
    const m = createReplayModel(
      new Map([["case-a", { ...good, toolCalls: [{ tool: "read:x" }] }]]),
    );
    const first = await m.complete(req("case-a"));
    (first.toolCalls as { tool: string }[]).push({ tool: "publish_site" });
    expect((await m.complete(req("case-a"))).toolCalls).toEqual([{ tool: "read:x" }]);
  });
  it("refuses a case with no recording, naming the case and never the prompt", async () => {
    const m = createReplayModel(new Map([["case-a", good]]));
    const err = await m.complete({ ...req("case-b"), prompt: "SECRET PROMPT" }).catch((e) => e);
    expect(err).toBeInstanceOf(EvalReplayError);
    expect(String(err.message)).toContain("case-b");
    expect(String(err.message)).not.toContain("SECRET PROMPT");
  });
  it("is not fooled by prototype names", async () => {
    const m = createReplayModel(new Map([["case-a", good]]));
    for (const id of ["__proto__", "constructor", "toString"])
      await expect(m.complete(req(id))).rejects.toBeInstanceOf(EvalReplayError);
  });
  it("needs no network, no key and no clock", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("network used");
    });
    const now = vi.spyOn(Date, "now").mockImplementation(() => {
      throw new Error("clock used");
    });
    const m = createReplayModel(new Map([["case-a", good]]));
    await expect(m.complete(req("case-a"))).resolves.toEqual(good);
    now.mockRestore();
  });
  it("refuses a malformed recording when it is built, naming its case", () => {
    const bad = (r: unknown) => () => createReplayModel(new Map([["case-x", r as EvalRecording]]));
    expect(bad({ usage })).toThrow(/case-x/);
    expect(bad({ text: "x", usage: { ...usage, costMicros: -1 } })).toThrow(/case-x/);
    expect(bad({ text: "x", usage: { ...usage, costMicros: 1.5 } })).toThrow(/case-x/);
    expect(bad({ text: "x", usage: { ...usage, latencyMs: Number.NaN } })).toThrow(/case-x/);
    expect(bad({ text: "x", usage: { inputTokens: 1 } })).toThrow(/case-x/);
    expect(bad({ text: "x", usage, toolCalls: [{ tool: 5 }] })).toThrow(/case-x/);
    expect(bad({ text: "x", usage, extra: 1 })).toThrow(/case-x/);
    expect(bad(null)).toThrow(/case-x/);
  });
});

describe("parseRecording", () => {
  it("accepts a recording read back from JSON", () => {
    expect(parseRecording(JSON.parse(JSON.stringify(good)))).toEqual(good);
  });
  it("returns null for anything else", () => {
    expect(parseRecording("text")).toBeNull();
    expect(parseRecording({ text: "x", usage: { ...usage, costMicros: 2 ** 60 } })).toBeNull();
  });
});

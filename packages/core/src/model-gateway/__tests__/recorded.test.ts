/**
 * The recorded fake (AG-19): the AG-09 replay behind the gateway's adapter interface, a recorder that
 * captures a live run once, and a file form that refuses a key.
 */
import { describe, expect, it } from "vitest";
import type { EvalRecording } from "../../evals/types.js";
import { EvalReplayError } from "../../evals/replay.js";
import { createGateway } from "../gateway.js";
import {
  RECORDED_PROVIDER,
  createRecordedAdapter,
  recordGateway,
  recordingsFromJson,
  recordingsToJson,
} from "../recorded.js";
import { ANSWER, CONFIG, REQUEST, SHAPED_KEY, setup } from "./helpers.js";

const CFG = {
  provider: RECORDED_PROVIDER,
  tiers: { fast: "recorded-small", strong: "recorded-large" },
};
const rec = (text: string): EvalRecording => ({ ...ANSWER, text });
const fake = (entries: Record<string, EvalRecording>) =>
  createGateway({
    config: { ...CFG, timeoutMs: 5_000, maxInputChars: 100_000, maxOutputTokens: 1_024 },
    adapters: [createRecordedAdapter(new Map(Object.entries(entries)))],
    env: () => {
      throw new Error("the fake must not read the environment");
    },
  });

describe("the recorded adapter", () => {
  it("answers a call from the recording with its call id, and needs no key", async () => {
    const g = fake({ "call-1": rec("one"), "call-2": rec("two") });
    expect((await g.complete(REQUEST)).text).toBe("one");
    expect((await g.complete({ ...REQUEST, callId: "call-2", tier: "strong" })).text).toBe("two");
  });

  it("answers the same way every time, and a caller cannot change what the next replay gives", async () => {
    const g = fake({ "call-1": { ...rec("one"), toolCalls: [{ tool: "read:finding" }] } });
    const first = await g.complete(REQUEST);
    first.toolCalls = [{ tool: "publish_site" }];
    first.usage.costMicros = 0;
    const second = await g.complete(REQUEST);
    expect(second.toolCalls).toEqual([{ tool: "read:finding" }]);
    expect(second.usage.costMicros).toBe(ANSWER.usage.costMicros);
  });

  it("refuses a call with no recording, naming the call", async () => {
    const g = fake({ "call-1": rec("one") });
    await expect(g.complete({ ...REQUEST, callId: "call-9" })).rejects.toMatchObject({
      code: "provider-error",
      message: expect.stringContaining("call-9"),
    });
  });

  it("refuses a recording that is not well formed when it is built", () => {
    expect(() =>
      createRecordedAdapter(new Map([["c", { text: "x" } as unknown as EvalRecording]])),
    ).toThrow(EvalReplayError);
  });

  it("is the provider named 'recorded', which has no key variable and no host", () => {
    const a = createRecordedAdapter(new Map());
    expect(a).toMatchObject({ provider: "recorded", needsKey: false });
  });
});

describe("recording a live run", () => {
  it("captures each answer by call id, and the capture replays to the same answers", async () => {
    const { gateway } = setup({
      run: async (c) => ({ ...ANSWER, text: `answer to ${c.callId}` }),
    });
    const r = recordGateway(gateway);
    const live = [
      await r.gateway.complete(REQUEST),
      await r.gateway.complete({ ...REQUEST, callId: "call-2" }),
    ];
    const replayed = fake(Object.fromEntries(r.recordings()));
    const again = [
      await replayed.complete(REQUEST),
      await replayed.complete({ ...REQUEST, callId: "call-2" }),
    ];
    expect(again.map((a) => a.text)).toEqual(live.map((a) => a.text));
    expect(again.map((a) => a.usage)).toEqual(live.map((a) => a.usage));
  });

  it("holds the answers and their cost, never the prompt, the key or the model's name", async () => {
    const { gateway } = setup();
    const r = recordGateway(gateway);
    await r.gateway.complete({ ...REQUEST, prompt: "A unique prompt sentence." });
    const json = recordingsToJson(r.recordings());
    expect(json).not.toContain("unique prompt");
    expect(json).not.toContain(CONFIG.keyEnv);
    expect(json).not.toContain("small-model");
  });

  it("records nothing for a call that failed", async () => {
    const { gateway } = setup();
    const r = recordGateway(gateway);
    await expect(r.gateway.complete({ ...REQUEST, tier: "nope" as never })).rejects.toBeDefined();
    expect(r.recordings().size).toBe(0);
  });
});

describe("the recordings file", () => {
  it("is the same text every time, in call-id order, and reads back to the same recordings", () => {
    const m = new Map([
      ["b", rec("two")],
      ["a", rec("one")],
    ]);
    const json = recordingsToJson(m);
    expect(json).toBe(recordingsToJson(new Map([...m].reverse())));
    expect(Object.keys(JSON.parse(json))).toEqual(["a", "b"]);
    expect([...recordingsFromJson(json)]).toEqual([
      ["a", rec("one")],
      ["b", rec("two")],
    ]);
  });

  it.each([
    ["text that is not JSON", "{"],
    ["a list", "[]"],
    ["a recording with no usage", '{"a":{"text":"x"}}'],
    ["a recording with an extra key", JSON.stringify({ a: { ...ANSWER, prompt: "p" } })],
    [
      "a recording with a fraction",
      JSON.stringify({ a: { ...ANSWER, usage: { ...ANSWER.usage, costMicros: 0.5 } } }),
    ],
    ["an id with a line break", JSON.stringify({ "a\nb": ANSWER })],
  ])("refuses %s", (_n, text) => {
    expect(() => recordingsFromJson(text)).toThrow(EvalReplayError);
  });

  it("refuses a recording that holds a key, and does not repeat it", () => {
    const text = JSON.stringify({ a: rec(`Use ${SHAPED_KEY} to log in.`) });
    expect(() => recordingsFromJson(text)).toThrow(EvalReplayError);
    try {
      recordingsFromJson(text);
    } catch (e) {
      expect((e as Error).message).not.toContain(SHAPED_KEY);
    }
  });

  it("refuses a file with more than 10000 recordings", () => {
    const many = Object.fromEntries(Array.from({ length: 10_001 }, (_, i) => [`c${i}`, ANSWER]));
    expect(() => recordingsFromJson(JSON.stringify(many))).toThrow(EvalReplayError);
  });
});

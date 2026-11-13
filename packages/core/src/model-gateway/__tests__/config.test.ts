/**
 * The config shape (AG-19): a provider, a model id per tier and the NAME of the variable that holds the key.
 * A key's value has no place in it, and an error about a config never repeats what was written in it.
 */
import { describe, expect, it } from "vitest";
import { parseGatewayConfig } from "../config.js";
import { MAX_PROMPT_CHARS } from "../types.js";
import { PLAIN_KEY, SHAPED_KEY } from "./helpers.js";

const GOOD = {
  provider: "example",
  keyEnv: "EXAMPLE_API_KEY",
  tiers: { fast: "small-model", strong: "large-model-2026-01" },
};
const problems = (raw: unknown): string[] => {
  const r = parseGatewayConfig(raw);
  expect(r.ok).toBe(false);
  return r.ok ? [] : r.problems;
};

describe("a valid config", () => {
  it("gets its limits filled in", () => {
    const r = parseGatewayConfig(GOOD);
    expect(r).toEqual({
      ok: true,
      config: {
        ...GOOD,
        timeoutMs: 30_000,
        maxInputChars: MAX_PROMPT_CHARS,
        maxOutputTokens: 1_024,
      },
    });
  });

  it("may name one tier only, and may leave out the key variable for a provider that needs none", () => {
    expect(parseGatewayConfig({ provider: "recorded", tiers: { fast: "x" } }).ok).toBe(true);
  });

  it("survives a round trip through JSON, which is how a file holds it", () => {
    const r = parseGatewayConfig(JSON.parse(JSON.stringify(GOOD)));
    expect(r.ok && r.config.tiers.strong).toBe("large-model-2026-01");
  });
});

describe("a config with a key in it", () => {
  it.each(["apiKey", "key", "token", "secret", "authorization"])(
    "refuses a %s setting, and says to name the variable instead",
    (name) => {
      const p = problems({ ...GOOD, [name]: PLAIN_KEY });
      expect(p.join("\n")).toMatch(/keyEnv/);
      expect(p.join("\n")).not.toContain(PLAIN_KEY);
    },
  );

  it.each([
    ["a key pasted where the variable name goes", SHAPED_KEY],
    ["a key-like value in capitals", ["AKIA", "IOSFODNN7EXAMPLE"].join("")],
    ["a value with a dash", PLAIN_KEY],
    ["a value in lower case", "example_api_key"],
    ["an empty name", ""],
    ["a name that is far too long", "A".repeat(65)],
  ])("refuses %s as keyEnv, and never repeats it", (_n, value) => {
    const p = problems({ ...GOOD, keyEnv: value });
    expect(p.join("\n")).toContain("keyEnv");
    if (value !== "") expect(p.join("\n")).not.toContain(value);
  });

  it("does not repeat a pasted key from any other place in the config", () => {
    const p = problems({
      provider: SHAPED_KEY,
      tiers: { fast: SHAPED_KEY },
      timeoutMs: SHAPED_KEY,
    });
    expect(p.length).toBeGreaterThan(0);
    expect(p.join("\n")).not.toContain(SHAPED_KEY);
  });

  it("does not repeat a key that is the name of a setting", () => {
    const p = problems({ ...GOOD, [SHAPED_KEY]: 1 });
    expect(p.join("\n")).not.toContain(SHAPED_KEY);
  });
});

describe("a config that tries to say where to send", () => {
  it.each(["host", "baseUrl", "url", "endpoint", "proxy", "allowPrivate"])(
    "has no %s setting: the hosts a provider can reach are kept in code, never in a file",
    (name) => {
      expect(problems({ ...GOOD, [name]: "https://api.example.test" }).join("\n")).toContain(name);
    },
  );
});

describe("a config that is wrong", () => {
  it.each([
    ["not an object", "recorded"],
    ["a list", [GOOD]],
    ["null", null],
    ["no provider", { ...GOOD, provider: undefined }],
    ["a provider with a space", { ...GOOD, provider: "Some Provider" }],
    ["no tiers", { ...GOOD, tiers: {} }],
    ["a tier that does not exist", { ...GOOD, tiers: { fast: "a", ultra: "b" } }],
    ["a model id with a space", { ...GOOD, tiers: { fast: "small model" } }],
    ["a model id that is empty", { ...GOOD, tiers: { fast: "" } }],
    ["a model id that is a number", { ...GOOD, tiers: { fast: 4 } }],
    ["a timeout under 100 ms", { ...GOOD, timeoutMs: 99 }],
    ["a timeout over two minutes", { ...GOOD, timeoutMs: 120_001 }],
    ["a timeout with a fraction", { ...GOOD, timeoutMs: 1000.5 }],
    ["an input cap of zero", { ...GOOD, maxInputChars: 0 }],
    ["an input cap above the hard cap", { ...GOOD, maxInputChars: MAX_PROMPT_CHARS + 1 }],
    ["an output cap of zero", { ...GOOD, maxOutputTokens: 0 }],
    ["an output cap that is text", { ...GOOD, maxOutputTokens: "1024" }],
  ])("refuses %s", (_n, raw) => {
    expect(problems(raw).length).toBeGreaterThan(0);
  });

  it("names each problem with where it is", () => {
    const p = problems({ ...GOOD, timeoutMs: 1, tiers: { fast: "a b" } });
    expect(p.some((l) => l.startsWith("timeoutMs:"))).toBe(true);
    expect(p.some((l) => l.startsWith("tiers.fast:"))).toBe(true);
  });
});

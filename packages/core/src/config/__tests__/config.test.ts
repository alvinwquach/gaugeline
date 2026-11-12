import { describe, expect, it } from "vitest";
import { ConfigError, defineCheck, type Check } from "../../index.js";
import { CheckRegistry } from "../../model.js";
import { parseConfig, registerCustomChecks } from "../schema.js";

function mine(id: string): Check<unknown> {
  return defineCheck({
    id,
    area: "content",
    severity: "low",
    title: "Opening hours missing",
    what: "w",
    why: "y",
    fix: "f",
    tech: "t",
    size: "S",
    done: "d",
    estimateChanges: "e",
    run: () => [],
  });
}

function message(raw: unknown): string {
  try {
    parseConfig(raw, "gaugeline.config.json");
  } catch (err) {
    expect(err).toBeInstanceOf(ConfigError);
    return (err as ConfigError).message;
  }
  throw new Error("expected a ConfigError");
}

describe("config schema: unit", () => {
  it("accepts an empty file and the three modes", () => {
    expect(parseConfig({}, "c")).toEqual({ checks: {}, custom: [], suppress: [] });
    const c = parseConfig({ checks: { "canonical-elsewhere": "block", x: "warn", y: "off" } }, "c");
    expect(c.checks).toEqual({ "canonical-elsewhere": "block", x: "warn", y: "off" });
  });

  it("every invalid shape gives a message naming the key", () => {
    expect(message([])).toContain("the file");
    expect(message({ checks: [] })).toContain("checks");
    expect(message({ checks: { "canonical-elsewhere": "fail" } })).toContain(
      "checks.canonical-elsewhere",
    );
    expect(message({ custom: "x" })).toContain("custom");
    expect(message({ custom: [{ id: "x" }] })).toContain("custom.0");
    expect(message({ suppress: {} })).toContain("suppress");
    expect(message({ suppress: [{ until: "2026-12-01", reason: "r" }] })).toContain(
      "suppress.0.id",
    );
    expect(message({ suppress: [{ id: "a", until: "2026-12-01" }] })).toContain(
      "suppress.0.reason",
    );
    expect(message({ suppress: [{ id: "a", until: "soon", reason: "r" }] })).toContain(
      "suppress.0.until",
    );
    expect(message({ suppress: [{ id: "a", until: "2026-02-30", reason: "r" }] })).toContain(
      "suppress.0.until",
    );
    expect(message({ suppress: [{ id: "a", until: "2026-12-01", reason: "  " }] })).toContain(
      "suppress.0.reason",
    );
  });

  it("names every file path with the file's name", () => {
    expect(message({ checks: 3 })).toMatch(/^gaugeline\.config\.json: /);
  });

  it("a suppression with no date is a config error", () => {
    const m = message({ suppress: [{ id: "a", reason: "client is away" }] });
    expect(m).toContain("suppress.0.until");
    expect(m).toContain("date");
  });

  it("an unknown key is refused by name: a file cannot carry --allow-private or --owner-consent", () => {
    expect(message({ allowPrivate: true })).toContain("allowPrivate");
    expect(message({ ownerConsent: true })).toContain("ownerConsent");
    expect(message({ fetcher: { guard: false } })).toContain("fetcher");
  });

  it("a custom check is validated like a built-in: a bad id is named", () => {
    const bad = { ...mine("fine"), id: "Not Kebab" };
    expect(message({ custom: [bad] })).toContain("custom.0");
  });
});

describe("custom checks and built-ins", () => {
  it("a custom id must not collide with a built-in", () => {
    const registry = new CheckRegistry().register(mine("canonical-elsewhere"));
    const config = parseConfig({ custom: [mine("canonical-elsewhere")] }, "c");
    expect(() => registerCustomChecks(registry, config.custom, "c")).toThrow(/custom\.0\.id/);
    expect(() => registerCustomChecks(registry, config.custom, "c")).toThrow(/built-in/);
  });

  it("two custom checks with one id collide too", () => {
    const config = parseConfig({ custom: [mine("my-rule"), mine("my-rule")] }, "c");
    expect(() => registerCustomChecks(new CheckRegistry(), config.custom, "c")).toThrow(
      /custom\.1\.id/,
    );
  });

  it("registers a custom check that does not collide", () => {
    const registry = new CheckRegistry();
    registerCustomChecks(registry, [mine("hours-listed")], "c");
    expect(registry.has("hours-listed")).toBe(true);
  });
});

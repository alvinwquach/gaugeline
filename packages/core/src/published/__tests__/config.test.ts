import { describe, expect, it } from "vitest";
import { adaptersConfigSchema } from "../../adapters/config.js";

const base = { adapters: [{ id: "sanity" }] };

describe("the live entry of gaugeline.adapters.json: unit", () => {
  it("is optional, and a file without it still parses", () => {
    expect(adaptersConfigSchema.safeParse(base).success).toBe(true);
  });

  it("accepts the four settings", () => {
    const r = adaptersConfigSchema.safeParse({
      ...base,
      live: { days: 14, graceMinutes: 30, maxPages: 10, fields: { menu: ["title", "heading"] } },
    });
    expect(r.success).toBe(true);
  });

  it.each([
    ["days of zero", { days: 0 }],
    ["more than 90 days", { days: 91 }],
    ["a fractional grace period", { graceMinutes: 1.5 }],
    ["a negative grace period", { graceMinutes: -1 }],
    ["no pages", { maxPages: 0 }],
    ["an unknown key", { retries: 3 }],
    ["an empty field list", { fields: { menu: [] } }],
    ["a field name with a space", { fields: { menu: ["the title"] } }],
  ])("refuses %s", (_name, live) => {
    expect(adaptersConfigSchema.safeParse({ ...base, live }).success).toBe(false);
  });
});

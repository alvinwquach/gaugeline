import { describe, expect, it } from "vitest";
import { catalogue } from "../catalogue.js";
import { createPageRegistry } from "../checks/index.js";
import { CheckRegistry, defineCheck, type Check, type Severity } from "../model.js";

const base = {
  area: "Visitors",
  what: "w",
  why: "y",
  fix: "Do the thing.",
  tech: "t",
  size: "S",
  done: "Done.",
  estimateChanges: "Nothing.",
  run: () => [],
} as const;
const make = (id: string, severity: Severity, title = id): Check<unknown> =>
  defineCheck<unknown>({ ...base, id, severity, title });

describe("catalogue: unit", () => {
  it("defineCheck throws when what, why, fix or tech is empty or whitespace, naming the check id and the field", () => {
    for (const field of ["what", "why", "fix", "tech"] as const) {
      for (const empty of ["", "   "]) {
        expect(() =>
          defineCheck({ ...base, id: "half-written", severity: "low", title: "t", [field]: empty }),
        ).toThrow(`Check "half-written" has an empty ${field}.`);
      }
    }
  });

  it("orders high before medium before low, keeping registration order inside a level", () => {
    const r = new CheckRegistry();
    for (const c of [
      make("l-one", "low"),
      make("h-one", "high"),
      make("m-one", "medium"),
      make("h-two", "high"),
      make("l-two", "low"),
    ])
      r.register(c);
    expect(catalogue(r).map((e) => e.id)).toEqual(["h-one", "h-two", "m-one", "l-one", "l-two"]);
  });

  it("has no function-valued property and serialises to JSON unchanged", () => {
    const entries = catalogue(createPageRegistry());
    for (const e of entries)
      for (const v of Object.values(e)) expect(typeof v).not.toBe("function");
    expect(JSON.parse(JSON.stringify(entries))).toEqual(entries);
    expect(Object.keys(entries[0] ?? {}).sort()).toEqual([
      "area",
      "done",
      "estimateChanges",
      "fix",
      "id",
      "severity",
      "size",
      "tech",
      "title",
      "what",
      "why",
    ]);
  });

  it("every registered check has a title under 80 characters and a fix that is a full sentence", () => {
    for (const e of catalogue(createPageRegistry())) {
      expect(e.title.length, e.id).toBeLessThan(80);
      expect(e.fix, e.id).toMatch(/^[A-Z].*[.]$/);
    }
  });
});

describe("catalogue: edge cases", () => {
  it("two checks with the same title fail", () => {
    const r = new CheckRegistry().register(make("first-one", "low", "Same title"));
    r.register(make("second-one", "low", "Same title"));
    expect(() => catalogue(r)).toThrow(
      'Checks "first-one" and "second-one" have the same title: "Same title".',
    );
  });
});

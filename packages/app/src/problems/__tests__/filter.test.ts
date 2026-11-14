import { describe, expect, it } from "vitest";
import { finding } from "../../__tests__/helpers";
import type { Level } from "../../types";
import { areaOf, facetCounts, filterFindings } from "../filter";

// Real check ids, so the areas are the catalogue's: canonical-elsewhere and og-image-missing are
// Search & sharing; images-heavy, images-broken and broken-links are Visitors; email-spf-missing is
// Security & email; the last id is one this build has never heard of.
const f0 = finding({ checkId: "canonical-elsewhere", severity: "high", title: "f0" });
const f1 = finding({ checkId: "images-heavy", severity: "medium", title: "f1" });
const f2 = finding({ checkId: "og-image-missing", severity: "low", title: "f2" });
const f3 = finding({ checkId: "images-broken", severity: "high", title: "f3" });
const f4 = finding({ checkId: "email-spf-missing", severity: "medium", title: "f4" });
const f5 = finding({ checkId: "from-a-newer-version", severity: "low", title: "f5" });
const mixed = [f0, f1, f2, f3, f4, f5];

const none = { levels: new Set<Level>(), areas: new Set<string>() };
const titles = (list: readonly { title: string }[]) => list.map((f) => f.title);

describe("areaOf", () => {
  it("is the catalogue's area, or Other checks for an id this build does not know", () => {
    expect(areaOf(f0)).toBe("Search & sharing");
    expect(areaOf(f3)).toBe("Visitors");
    expect(areaOf(f5)).toBe("Other checks");
  });
});

describe("filterFindings", () => {
  it("with no filters keeps every finding, in the order given", () => {
    expect(titles(filterFindings(mixed, none))).toEqual(["f0", "f1", "f2", "f3", "f4", "f5"]);
  });

  it("with one level keeps that level", () => {
    expect(titles(filterFindings(mixed, { ...none, levels: new Set<Level>(["high"]) }))).toEqual([
      "f0",
      "f3",
    ]);
  });

  it("with two levels keeps either (OR inside one filter)", () => {
    const got = filterFindings(mixed, { ...none, levels: new Set<Level>(["high", "low"]) });
    expect(titles(got)).toEqual(["f0", "f2", "f3", "f5"]);
  });

  it("with one area keeps that area", () => {
    expect(titles(filterFindings(mixed, { ...none, areas: new Set(["Visitors"]) }))).toEqual([
      "f1",
      "f3",
    ]);
  });

  it("with two areas keeps either", () => {
    const got = filterFindings(mixed, {
      ...none,
      areas: new Set(["Visitors", "Security & email"]),
    });
    expect(titles(got)).toEqual(["f1", "f3", "f4"]);
  });

  it("with a level and an area keeps what is both (AND between filters)", () => {
    const got = filterFindings(mixed, {
      levels: new Set<Level>(["high"]),
      areas: new Set(["Visitors"]),
    });
    expect(titles(got)).toEqual(["f3"]);
  });

  it("a combination that matches nothing gives an empty list", () => {
    const got = filterFindings(mixed, {
      levels: new Set<Level>(["low"]),
      areas: new Set(["Security & email"]),
    });
    expect(got).toEqual([]);
  });

  it("does not change its input, and keeps extra fields on what it returns", () => {
    const withIndex = mixed.map((f, index) => ({ ...f, index }));
    const copy = [...withIndex];
    const got = filterFindings(withIndex, { ...none, levels: new Set<Level>(["medium"]) });
    expect(got.map((f) => f.index)).toEqual([1, 4]);
    expect(withIndex).toEqual(copy);
  });

  it("an empty list stays empty", () => {
    expect(filterFindings([], { ...none, levels: new Set<Level>(["high"]) })).toEqual([]);
  });

  it("500 findings are filtered well inside one frame (16 ms)", () => {
    const many = Array.from({ length: 500 }, (_, i) => mixed[i % mixed.length] as typeof f0);
    const filters = { levels: new Set<Level>(["high", "medium"]), areas: new Set(["Visitors"]) };
    filterFindings(many, filters); // warm up
    const start = performance.now();
    const got = filterFindings(many, filters);
    const took = performance.now() - start;
    expect(got.length).toBeGreaterThan(0);
    expect(took).toBeLessThan(16);
  });
});

describe("facetCounts", () => {
  it("matches a hand count for a mixed result", () => {
    const { levels, areas } = facetCounts(mixed);
    // high: f0 f3. medium: f1 f4. low: f2 f5.
    expect(levels).toEqual(
      new Map<Level, number>([
        ["high", 2],
        ["medium", 2],
        ["low", 2],
      ]),
    );
    expect(areas).toEqual(
      new Map([
        ["Search & sharing", 2],
        ["Visitors", 2],
        ["Security & email", 1],
        ["Other checks", 1],
      ]),
    );
  });

  it("offers only the areas that have findings, in the report's order", () => {
    const { areas } = facetCounts([f4, f3]);
    expect([...areas.keys()]).toEqual(["Visitors", "Security & email"]);
  });

  it("always has the three levels, with zero where there is nothing", () => {
    const { levels } = facetCounts([f0]);
    expect([...levels.entries()]).toEqual([
      ["high", 1],
      ["medium", 0],
      ["low", 0],
    ]);
  });

  it("is empty for no findings", () => {
    const { levels, areas } = facetCounts([]);
    expect([...levels.values()]).toEqual([0, 0, 0]);
    expect(areas.size).toBe(0);
  });
});

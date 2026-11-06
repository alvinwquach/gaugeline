import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { SITES_DIR } from "../../../../fixtures/src/index.js";
import { addressKey, groupBy, textKey } from "../keys.js";
import { readPlan, type PlanRow } from "../read.js";
import { checkPlan } from "../self.js";

const PLANS = `${SITES_DIR}../plans/`;
const row = (line: number, url: string, extra: Partial<PlanRow> = {}): PlanRow => {
  const hash = url.indexOf("#");
  const path = (hash >= 0 ? url.slice(0, hash) : url).replace(/^https?:\/\/[^/]+/, "") || "/";
  return {
    line,
    url,
    path,
    ...(hash >= 0 ? { fragment: url.slice(hash + 1) } : {}),
    raw: {},
    ...extra,
  };
};
const ids = (rows: PlanRow[]) => checkPlan(rows, "plan.csv").map((f) => [f.checkId, f.evidence]);

describe("plan self-check: unit", () => {
  it("each rule: a passing table and a failing table", () => {
    expect(
      ids([row(2, "/a", { titleTag: "A", h1: "A" }), row(3, "/b", { titleTag: "B", h1: "B" })]),
    ).toEqual([]);
    expect(ids([row(2, "/a"), row(3, "/a")])).toEqual([
      ["plan-duplicate-address", "/a on lines 2 and 3 (2 rows)"],
    ]);
    expect(
      ids([row(2, "/a", { titleTag: "Billing" }), row(3, "/b", { titleTag: "Billing" })]),
    ).toEqual([["plan-duplicate-title", '"Billing" on lines 2 and 3 (2 rows)']]);
    expect(ids([row(2, "/a", { h1: "Coding" }), row(3, "/b", { h1: "Coding" })])).toEqual([
      ["plan-duplicate-h1", '"Coding" on lines 2 and 3 (2 rows)'],
    ]);
  });

  it("addressKey: trailing slash, upper case, www and bare host, a query, a fragment", () => {
    expect(addressKey(row(1, "/Software/AI/"))).toBe(addressKey(row(1, "/software/ai")));
    expect(addressKey(row(1, "https://www.shop.example/a"))).toBe(
      addressKey(row(1, "https://shop.example/a")),
    );
    expect(addressKey({ url: "/a?utm=1", path: "/a?utm=1" })).toBe("/a");
    expect(addressKey(row(1, "/medical#Rural"))).toBe("/medical#rural");
    expect(addressKey(row(1, "/"))).toBe("/");
  });

  it("textKey: curly and straight apostrophes are equal, spaces collapse", () => {
    expect(textKey("  Kim’s   Billing – Guide ")).toBe(textKey("kim's billing - guide"));
  });

  it("groupBy leaves out undefined keys and keeps file order inside a group", () => {
    const groups = groupBy([1, 2, 3, 4, 5, 6], (n) =>
      n === 3 ? undefined : n % 2 === 0 ? "even" : "odd",
    );
    expect([...groups]).toEqual([
      ["odd", [1, 5]],
      ["even", [2, 4, 6]],
    ]);
  });
});

describe("plan self-check: integration (the invented keyword map)", () => {
  const plan = () => readPlan(readFileSync(`${PLANS}keyword-map.csv`, "utf8"));

  it("exactly two duplicate-address groups: /software/ai-automation (3) and /software/intelligent-platform (2)", () => {
    expect(ids(plan().rows).filter(([id]) => id === "plan-duplicate-address")).toEqual([
      ["plan-duplicate-address", "/software/ai-automation on lines 146, 147 and 148 (3 rows)"],
      ["plan-duplicate-address", "/software/intelligent-platform on lines 149 and 150 (2 rows)"],
    ]);
  });

  it("the 7 anchor rows that share a path with each other are not duplicates", () => {
    const anchors = plan().rows.filter((r) => r.fragment);
    expect(anchors).toHaveLength(7);
    expect(checkPlan(anchors)).toEqual([]);
  });
});

describe("plan self-check: edge cases", () => {
  it("trailing slash and case differences are one address", () => {
    expect(ids([row(2, "/Billing/"), row(3, "/billing")])[0]?.[0]).toBe("plan-duplicate-address");
  });

  it("an anchor row and its page row are not duplicates; two identical anchors are", () => {
    expect(ids([row(2, "/medical"), row(3, "/medical#rural")])).toEqual([]);
    expect(ids([row(2, "/medical#rural"), row(3, "/medical#rural")])).toEqual([
      ["plan-duplicate-address", "/medical#rural on lines 2 and 3 (2 rows)"],
    ]);
  });

  it("a title that differs only by its brand suffix is a different title; empty titles are left out", () => {
    expect(
      ids([
        row(2, "/a", { titleTag: "Billing" }),
        row(3, "/b", { titleTag: "Billing | Harbourline" }),
      ]),
    ).toEqual([]);
    expect(ids([row(2, "/a", { titleTag: "" }), row(3, "/b", { titleTag: " " })])).toEqual([]);
  });

  it("rows with no URL never reach the check (the reader skips them)", () => {
    const p = readPlan("Page,URL,Title\nMenu,,Same\nA,/a,Same\n");
    expect(p.skipped).toBe(1);
    expect(checkPlan(p.rows)).toEqual([]);
  });

  it("5,000 rows complete in under a second", () => {
    const rows = Array.from({ length: 5000 }, (_, i) =>
      row(i + 2, `/p/${i % 4900}`, { titleTag: `T ${i}`, h1: `H ${i}` }),
    );
    const start = performance.now();
    const found = checkPlan(rows);
    expect(performance.now() - start).toBeLessThan(1000);
    expect(found).toHaveLength(100);
  });
});

describe("plan self-check: promise", () => {
  it("makes no request", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    checkPlan(readPlan(readFileSync(`${PLANS}keyword-map.csv`, "utf8")).rows);
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

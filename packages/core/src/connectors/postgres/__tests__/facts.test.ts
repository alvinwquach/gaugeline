import { describe, expect, it } from "vitest";
import { factsFromResult } from "../facts.js";
import type { DatabaseQueryResult } from "../connector.js";

function result(
  rows: Array<Record<string, string | number | boolean | null>>,
): DatabaseQueryResult {
  return {
    source: "db",
    query: "q",
    status: "ok",
    columns: Object.keys(rows[0] ?? {}),
    rows,
    truncated: false,
  };
}

describe("factsFromResult", () => {
  it("maps whole cents to price facts, with ids that name the source, the query and the row", () => {
    const out = factsFromResult(
      result([
        { name: "Mezcal Mule", cents: 1250 },
        { name: "Paloma", cents: "1305" },
        { name: "Shot", cents: 5 },
      ]),
      { kind: "price", item: "name", value: "cents", unit: "minor", currency: "$" },
    );
    expect(out.skipped).toBe(0);
    expect(out.facts).toEqual([
      { id: "db.q.1", kind: "price", item: "Mezcal Mule", value: "$12.50" },
      { id: "db.q.2", kind: "price", item: "Paloma", value: "$13.05" },
      { id: "db.q.3", kind: "price", item: "Shot", value: "$0.05" },
    ]);
  });

  it("maps dollars with the same integer reading, never a float (19.99 stays 19.99)", () => {
    const out = factsFromResult(
      result([
        { n: "Tasting box", p: "19.99" },
        { n: "Ticket", p: 48 },
        { n: "Big", p: "1,299.00" },
      ]),
      {
        kind: "price",
        item: "n",
        value: "p",
        unit: "major",
        currency: "£",
      },
    );
    expect(out.facts.map((f) => (f.kind === "price" ? f.value : ""))).toEqual([
      "£19.99",
      "£48.00",
      "£1299.00",
    ]);
  });

  it("skips and counts a row it cannot read: no name, no value, not a plain amount", () => {
    const out = factsFromResult(
      result([
        { name: "Ok", cents: 100 },
        { name: null, cents: 100 },
        { name: "No price", cents: null },
        { name: "Fraction", cents: "12.5" },
        { name: "Negative", cents: -5 },
        { name: "Word", cents: "free" },
      ]),
      { kind: "price", item: "name", value: "cents", unit: "minor", currency: "$" },
    );
    expect(out.facts).toHaveLength(1);
    expect(out.skipped).toBe(5);
  });

  it("maps text, trimmed, and carries mustAppearOn", () => {
    const out = factsFromResult(
      result([{ name: "  Negroni " }, { name: "" }, { name: "Paloma" }]),
      {
        kind: "text",
        value: "name",
        mustAppearOn: ["/menu"],
      },
    );
    expect(out.facts).toEqual([
      { id: "db.q.1", kind: "text", value: "Negroni", mustAppearOn: ["/menu"] },
      { id: "db.q.3", kind: "text", value: "Paloma", mustAppearOn: ["/menu"] },
    ]);
    expect(out.skipped).toBe(1);
  });

  it("gives no facts for a result with no rows", () => {
    expect(factsFromResult(result([]), { kind: "text", value: "x" })).toEqual({
      facts: [],
      skipped: 0,
    });
  });
});

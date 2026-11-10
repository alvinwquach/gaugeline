import { describe, expect, it } from "vitest";
import { sourcesConfigSchema } from "../../connectors/postgres/config.js";
import { assertionsOf } from "../select.js";

const assertion = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: "no-overlapping-bookings",
  severity: "high",
  title: "Two private events are booked at the same time",
  sql: "select a.id as booking_id, a.starts_at from bookings a join bookings b on a.id < b.id and a.room = b.room and tstzrange(a.starts_at, a.ends_at) && tstzrange(b.starts_at, b.ends_at)",
  evidence: ["booking_id", "starts_at"],
  ...over,
});

const config = (
  assertions: unknown,
  sources: Record<string, unknown> = { db: { type: "postgres" } },
): unknown => ({ sources, assertions });

const parse = (v: unknown) => sourcesConfigSchema.safeParse(v);
const firstMessage = (v: unknown): string => {
  const r = parse(v);
  return r.success ? "" : (r.error.issues[0]?.message ?? "");
};
const firstPath = (v: unknown): string => {
  const r = parse(v);
  return r.success ? "" : (r.error.issues[0]?.path.join(".") ?? "");
};

describe("assertions in gaugeline.sources.json", () => {
  it("reads an assertion, and a source that has no named query of its own", () => {
    const c = sourcesConfigSchema.parse(config([assertion()]));
    expect(c.assertions).toHaveLength(1);
    expect(c.sources.db?.queries).toEqual({});
    expect(assertionsOf(c)).toEqual([{ assertion: c.assertions?.[0], source: "db" }]);
  });

  it("still needs a source to have a query or an assertion", () => {
    expect(parse({ sources: { db: { type: "postgres" } } }).success).toBe(false);
    expect(parse({ sources: { db: { type: "postgres", queries: {} } } }).success).toBe(false);
    expect(parse(config([])).success).toBe(false);
  });

  it.each([
    ["capitals", "No-Overlap"],
    ["an underscore", "no_overlap"],
    ["a leading digit", "1-overlap"],
    ["a trailing hyphen", "overlap-"],
    ["a double hyphen", "no--overlap"],
    ["a space", "no overlap"],
    ["empty", ""],
    ["64 characters and one more", "a".repeat(65)],
  ])("refuses an id with %s", (_name, id) => {
    expect(parse(config([assertion({ id })])).success).toBe(false);
  });

  it.each(["no-overlapping-bookings", "a", "orders-2026", "paid-orders-have-a-match"])(
    "accepts the id %s",
    (id) => {
      expect(parse(config([assertion({ id })])).success).toBe(true);
    },
  );

  it("needs a severity of high, medium or low", () => {
    expect(parse(config([assertion({ severity: "critical" })])).success).toBe(false);
    expect(parse(config([assertion({ severity: undefined })])).success).toBe(false);
    for (const severity of ["high", "medium", "low"])
      expect(parse(config([assertion({ severity })])).success).toBe(true);
  });

  it("needs evidence columns, named plainly and listed once", () => {
    expect(parse(config([assertion({ evidence: undefined })])).success).toBe(false);
    expect(parse(config([assertion({ evidence: [] })])).success).toBe(false);
    expect(firstMessage(config([assertion({ evidence: [] })]))).toMatch(/evidence column/);
    expect(parse(config([assertion({ evidence: ["booking id"] })])).success).toBe(false);
    expect(parse(config([assertion({ evidence: ["a", "a"] })])).success).toBe(false);
    expect(parse(config([assertion({ evidence: ["a", "*"] })])).success).toBe(false);
    expect(
      parse(config([assertion({ evidence: Array.from({ length: 11 }, (_, i) => `c${i}`) })]))
        .success,
    ).toBe(false);
  });

  it("needs a title and sql, and refuses keys it does not know", () => {
    expect(parse(config([assertion({ title: "" })])).success).toBe(false);
    expect(parse(config([assertion({ title: "x".repeat(141) })])).success).toBe(false);
    expect(parse(config([assertion({ sql: "" })])).success).toBe(false);
    expect(parse(config([assertion({ mask: ["email"] })])).success).toBe(false);
  });

  it("refuses two assertions with one id, naming it", () => {
    const c = config([assertion(), assertion({ title: "Another" })]);
    expect(parse(c).success).toBe(false);
    expect(firstMessage(c)).toContain("no-overlapping-bookings");
    expect(firstPath(c)).toBe("assertions.1.id");
  });

  it("refuses a source that is not in the file, and an ambiguous one", () => {
    const missing = config([assertion({ source: "warehouse" })]);
    expect(parse(missing).success).toBe(false);
    expect(firstMessage(missing)).toContain("warehouse");
    const two = config([assertion()], {
      db: { type: "postgres" },
      shop: { type: "postgres", queries: { q: "select 1" } },
    });
    expect(parse(two).success).toBe(false);
    expect(firstMessage(two)).toMatch(/which source/);
    const named = config([assertion({ source: "shop" })], {
      db: { type: "postgres", queries: { q: "select 1" } },
      shop: { type: "postgres" },
    });
    const ok = sourcesConfigSchema.parse(named);
    expect(assertionsOf(ok)[0]?.source).toBe("shop");
  });

  it("refuses an assertion that is not a pure read, naming the assertion, before anything could be sent", () => {
    const write = config([
      assertion({ id: "clears-old-bookings", sql: "delete from bookings where starts_at < now()" }),
    ]);
    const r = parse(write);
    expect(r.success).toBe(false);
    expect(firstPath(write)).toBe("assertions.0.sql");
    expect(firstMessage(write)).toContain('"clears-old-bookings"');
    expect(firstMessage(write)).toMatch(/DELETE/);
    // A write hidden in a CTE, and a function on the source's own deny list, are refused alike.
    expect(
      parse(
        config([
          assertion({
            sql: "with d as (delete from bookings returning id) select id as booking_id from d",
          }),
        ]),
      ).success,
    ).toBe(false);
    expect(
      parse(
        config([assertion({ sql: "select log_visit() as booking_id" })], {
          db: { type: "postgres", denyFunctions: ["log_visit"] },
        }),
      ).success,
    ).toBe(false);
  });

  it("refuses more than 100 assertions", () => {
    const many = Array.from({ length: 101 }, (_, i) => assertion({ id: `check-${i}` }));
    expect(parse(config(many)).success).toBe(false);
  });

  it("selects some assertions by id, in file order", () => {
    const c = sourcesConfigSchema.parse(
      config([
        assertion({ id: "a-one" }),
        assertion({ id: "b-two" }),
        assertion({ id: "c-three" }),
      ]),
    );
    expect(assertionsOf(c, ["c-three", "a-one"]).map((x) => x.assertion.id)).toEqual([
      "a-one",
      "c-three",
    ]);
    expect(assertionsOf(c, ["nope"])).toEqual([]);
  });
});

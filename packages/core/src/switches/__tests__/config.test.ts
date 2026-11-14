import { describe, expect, it } from "vitest";
import {
  MAX_STATE_PAGES,
  parseSourceRef,
  referenceProblems,
  resolveQuery,
  scopePaths,
  sourceRefs,
  switchesConfigSchema,
  usesSanity,
} from "../config.js";

const parse = (v: unknown) => switchesConfigSchema.safeParse(v);
const message = (v: unknown): string => {
  const r = parse(v);
  if (r.success) return "";
  const i = r.error.issues[0];
  return `${i?.path.join(".") ?? ""}: ${i?.message ?? ""}`;
};

const SWITCH = {
  id: "preorders",
  source: "sanity:siteSettings.features.preOrders",
  whenOff: { noLinksTo: ["/order"], pageSays: { "/order": "order at the bar" } },
};

describe("switches config: switch rules", () => {
  it("accepts the shape the spec gives", () => {
    expect(parse({ switches: [SWITCH] }).success).toBe(true);
  });

  it("accepts whenOn on its own, and noLinksTo or pageSays on their own", () => {
    expect(
      parse({ switches: [{ id: "a", source: "db:flag", whenOn: { pageSays: { "/x": "open" } } }] })
        .success,
    ).toBe(true);
    expect(
      parse({ switches: [{ id: "a", source: "db:flag", whenOff: { noLinksTo: ["/x"] } }] }).success,
    ).toBe(true);
  });

  it("refuses a switch that says nothing about what the site must do", () => {
    expect(message({ switches: [{ id: "a", source: "db:flag" }] })).toContain(
      'switch "a": say what the site must do',
    );
  });

  it("refuses a source that is neither sanity: nor db:", () => {
    expect(message({ switches: [{ ...SWITCH, source: "mysql:settings.preorders" }] })).toContain(
      "switches.0.source",
    );
  });

  it("refuses a Sanity source with no field, and field names with anything but plain characters", () => {
    expect(parse({ switches: [{ ...SWITCH, source: "sanity:siteSettings" }] }).success).toBe(false);
    expect(
      parse({ switches: [{ ...SWITCH, source: 'sanity:siteSettings.a"] || true' }] }).success,
    ).toBe(false);
  });

  it("refuses a path that is an address, has a query, or does not start with a slash", () => {
    for (const bad of ["https://shop.example/order", "/order?x=1", "order", "/a b"])
      expect(parse({ switches: [{ ...SWITCH, whenOff: { noLinksTo: [bad] } }] }).success).toBe(
        false,
      );
  });

  it("refuses an unknown key rather than ignoring it", () => {
    expect(parse({ switches: [{ ...SWITCH, whenOf: {} }] }).success).toBe(false);
    expect(parse({ switches: [SWITCH], extra: [] }).success).toBe(false);
  });

  it("refuses two rules with one id", () => {
    expect(message({ switches: [SWITCH, SWITCH] })).toContain('"preorders" is used by two rules');
  });

  it("refuses an empty file", () => {
    expect(message({})).toContain("add at least one of switches, availability or capacity");
  });
});

describe("switches config: per-language phrases", () => {
  it("accepts a phrase per language and refuses an invalid language code", () => {
    expect(
      parse({
        switches: [
          {
            ...SWITCH,
            whenOff: { pageSays: { "/order": { en: "order at the bar", es: "pida en la barra" } } },
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      parse({ switches: [{ ...SWITCH, whenOff: { pageSays: { "/order": { xx1: "x" } } } }] })
        .success,
    ).toBe(false);
  });

  it("refuses an empty phrase and an empty language list", () => {
    expect(
      parse({ switches: [{ ...SWITCH, whenOff: { pageSays: { "/order": "  " } } }] }).success,
    ).toBe(false);
    expect(
      parse({ switches: [{ ...SWITCH, whenOff: { pageSays: { "/order": {} } } }] }).success,
    ).toBe(false);
  });
});

describe("switches config: availability and capacity rules", () => {
  const AVAIL = {
    source: "db:eightySixed",
    items: "name",
    mustNotAppearOn: ["/menu", "/tonight"],
    alsoIn: "menu-jsonld",
  };
  const CAP = { source: "db:tonightRemaining", whenZero: { pageSays: { "/order": "sold out" } } };

  it("accepts the spec's availability and capacity shapes", () => {
    expect(parse({ availability: [AVAIL] }).success).toBe(true);
    expect(parse({ capacity: [CAP] }).success).toBe(true);
  });

  it("a db availability source needs the column; a Sanity one must not name one", () => {
    expect(message({ availability: [{ ...AVAIL, items: undefined }] })).toContain(
      "name the column that holds the item name",
    );
    expect(
      message({ availability: [{ ...AVAIL, source: "sanity:siteSettings.eightySixed" }] }),
    ).toContain("leave items out");
    expect(
      parse({
        availability: [{ source: "sanity:siteSettings.eightySixed", mustNotAppearOn: ["/menu"] }],
      }).success,
    ).toBe(true);
  });

  it("alsoIn only knows menu-jsonld", () => {
    expect(parse({ availability: [{ ...AVAIL, alsoIn: "anything" }] }).success).toBe(false);
  });

  it("a capacity rule must say what the page says at zero", () => {
    expect(parse({ capacity: [{ source: "db:tonightRemaining" }] }).success).toBe(false);
    expect(parse({ capacity: [{ ...CAP, whenZero: { pageSays: {} } }] }).success).toBe(false);
  });

  it("two availability rules on one source need ids", () => {
    expect(message({ availability: [AVAIL, AVAIL] })).toContain("is used by two rules");
    expect(
      parse({
        availability: [
          { ...AVAIL, id: "kitchen" },
          { ...AVAIL, id: "bar" },
        ],
      }).success,
    ).toBe(true);
  });
});

describe("switches config: pages and sources", () => {
  it("scopePaths lists every path once, without a trailing slash", () => {
    const config = switchesConfigSchema.parse({
      switches: [SWITCH],
      availability: [{ source: "db:q", items: "n", mustNotAppearOn: ["/menu", "/order/"] }],
      capacity: [{ source: "db:r", whenZero: { pageSays: { "/order": "sold out" } } }],
    });
    expect(scopePaths(config)).toEqual(["/order", "/menu"]);
  });

  it(`refuses a file that names more than ${MAX_STATE_PAGES} pages`, () => {
    const many = Array.from({ length: MAX_STATE_PAGES + 1 }, (_, i) => `/p${i}`);
    expect(
      message({
        availability: [
          { source: "db:q", items: "n", mustNotAppearOn: many.slice(0, 10) },
          { id: "b", source: "db:q", items: "n", mustNotAppearOn: many.slice(10) },
        ],
      }),
    ).toContain(`at most ${MAX_STATE_PAGES}`);
  });

  it("parseSourceRef reads both kinds, with or without a source name", () => {
    expect(parseSourceRef("sanity:siteSettings.features.preOrders")).toEqual({
      kind: "sanity",
      type: "siteSettings",
      fields: ["features", "preOrders"],
    });
    expect(parseSourceRef("db:eightySixed")).toEqual({ kind: "db", query: "eightySixed" });
    expect(parseSourceRef("db:kitchen.eightySixed")).toEqual({
      kind: "db",
      source: "kitchen",
      query: "eightySixed",
    });
  });

  const sources = {
    sources: {
      db: { queries: { eightySixed: "select 1", tonightRemaining: "select 2" } },
      other: { queries: { eightySixed: "select 3" } },
    },
  };

  it("resolveQuery finds a query by name, asks which source when two have it, and names what is missing", () => {
    expect(resolveQuery({ kind: "db", query: "tonightRemaining" }, sources)).toEqual({
      ok: true,
      key: "db.tonightRemaining",
    });
    expect(resolveQuery({ kind: "db", query: "eightySixed" }, sources)).toMatchObject({
      ok: false,
      message: expect.stringContaining("write db:db.eightySixed"),
    });
    expect(resolveQuery({ kind: "db", source: "other", query: "eightySixed" }, sources)).toEqual({
      ok: true,
      key: "other.eightySixed",
    });
    expect(resolveQuery({ kind: "db", query: "nope" }, sources)).toMatchObject({ ok: false });
    expect(resolveQuery({ kind: "db", source: "zzz", query: "q" }, sources)).toMatchObject({
      ok: false,
    });
    expect(resolveQuery({ kind: "db", query: "q" }, undefined)).toMatchObject({
      ok: false,
      message: expect.stringContaining("gaugeline.sources.json"),
    });
  });

  it("referenceProblems names each db source the sources file cannot answer, and ignores Sanity ones", () => {
    const config = switchesConfigSchema.parse({
      switches: [SWITCH],
      capacity: [{ source: "db:missing", whenZero: { pageSays: { "/order": "sold out" } } }],
    });
    expect(referenceProblems(config, sources)).toEqual([
      'capacity.0.source: "db:missing": no source in gaugeline.sources.json has a query "missing"',
    ]);
    expect(sourceRefs(config).map((r) => r.ref)).toEqual([
      "sanity:siteSettings.features.preOrders",
      "db:missing",
    ]);
    expect(usesSanity(config)).toBe(true);
  });
});

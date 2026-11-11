import { describe, expect, it } from "vitest";
import { buildResult } from "../../result.js";
import { brandSchema, safeLogoUrl, servicesConfigSchema, servicesProblem } from "../config.js";
import { buildAuditPack, forProspect, joinNames } from "../pack.js";
import { CHECKS, FINDINGS, SERVICES, check, finding, registry, resultOf } from "./world.js";

const lines = (text: string): string[] => text.split(/\r?\n/);

describe("audit pack: grouping findings into packages", () => {
  const pack = buildAuditPack(resultOf(FINDINGS), CHECKS, { services: SERVICES });

  it("puts each finding in the first package that covers it, by check id or by area", () => {
    const named = pack.groups.map((g) => [g.kind, g.name, g.items.map((i) => i.checkId)]);
    expect(named).toEqual([
      ["package", "Search and sharing tidy-up", ["canonical-elsewhere", "share-image-missing"]],
      ["package", "Phone and accessibility pass", ["viewport-missing", "alt-missing"]],
      ["other", "Other findings", ["menu-price-mismatch"]],
    ]);
  });

  it("counts a check once however many places it found, and keeps the work order's order", () => {
    expect(pack.total).toBe(5);
    expect(pack.levels).toEqual({ high: 2, medium: 2, low: 1 });
    expect(pack.top.map((i) => i.checkId)).toEqual([
      "canonical-elsewhere",
      "menu-price-mismatch",
      "viewport-missing",
      "alt-missing",
      "share-image-missing",
    ]);
  });

  it("leaves out a package with nothing to fix on this site", () => {
    expect(pack.groups.map((g) => g.name)).not.toContain("Email set-up");
  });

  it("gives a finding to the first package that covers it, so no finding is counted twice", () => {
    const services = servicesConfigSchema.parse({
      services: [
        { name: "A", covers: { areas: ["Visitors"] }, price: { from: 100, to: 200 } },
        { name: "B", covers: { checks: ["alt-missing"] }, price: { from: 50, to: 80 } },
      ],
    });
    const p = buildAuditPack(resultOf(FINDINGS), CHECKS, { services });
    expect(p.groups.find((g) => g.name === "A")?.items.map((i) => i.checkId)).toEqual([
      "viewport-missing",
      "alt-missing",
    ]);
    expect(p.groups.find((g) => g.name === "B")).toBeUndefined();
  });

  it("shows the places to look, three at most, and says how many more there were", () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      finding("alt-missing", "medium", `image ${i}`),
    );
    const p = buildAuditPack(resultOf(many), CHECKS);
    const item = p.top[0];
    expect(item?.evidence).toEqual([
      "image 0 (https://marlowe-bar.example/)",
      "image 1 (https://marlowe-bar.example/)",
      "image 2 (https://marlowe-bar.example/)",
    ]);
    expect(item?.moreEvidence).toBe(2);
  });

  it("gives each package a re-run line that names the host and its own checks", () => {
    const first = pack.groups[0];
    expect(first?.recheck).toBe(
      "We run Gaugeline again on marlowe-bar.example (npx gaugeline marlowe-bar.example) and confirm that \u201CTitle of canonical-elsewhere\u201D and \u201CTitle of share-image-missing\u201D are no longer reported.",
    );
    expect(pack.groups[1]?.recheck).toContain("are no longer reported");
    expect(pack.groups[2]?.recheck).toBe("");
  });
});

describe("audit pack: totals as ranges", () => {
  it("adds each package's own range and nothing else: prices in minor units, hours as written", () => {
    const pack = buildAuditPack(resultOf(FINDINGS), CHECKS, { services: SERVICES });
    expect(pack.groups[0]?.price).toEqual({ low: 45_000, high: 70_000 });
    expect(pack.groups[0]?.hours).toEqual({ low: 4, high: 6 });
    expect(pack.totals).toEqual({
      price: { low: 105_000, high: 160_000 },
      hours: { low: 4, high: 6 },
      withoutPrice: [],
      withoutHours: ["Phone and accessibility pass"],
    });
  });

  it("names the packages left out of a total because they lack that figure", () => {
    const services = servicesConfigSchema.parse({
      services: [
        { name: "Priced", covers: { areas: ["Visitors"] }, price: { from: 100, to: 200 } },
        { name: "By the hour", covers: { areas: ["Search & sharing"] }, hours: { from: 2, to: 3 } },
      ],
    });
    const pack = buildAuditPack(resultOf(FINDINGS), CHECKS, { services });
    expect(pack.totals).toEqual({
      price: { low: 10_000, high: 20_000 },
      hours: { low: 2, high: 3 },
      withoutPrice: ["By the hour"],
      withoutHours: ["Priced"],
    });
  });

  it("reads a price in a currency with no minor unit as whole units (yen)", () => {
    const services = servicesConfigSchema.parse({
      currency: "JPY",
      services: [
        { name: "Tidy-up", covers: { areas: ["Visitors"] }, price: { from: 50_000, to: 80_000 } },
      ],
    });
    const pack = buildAuditPack(resultOf(FINDINGS), CHECKS, { services });
    expect(pack.currency).toBe("jpy");
    expect(pack.groups[0]?.price).toEqual({ low: 50_000, high: 80_000 });
  });

  it("has no totals without a package", () => {
    expect(buildAuditPack(resultOf(FINDINGS), CHECKS).totals).toBeUndefined();
  });
});

describe("audit pack: without a services file", () => {
  const pack = buildAuditPack(resultOf(FINDINGS), CHECKS);

  it("groups the findings by area in the usual order, with no price, hours or re-run line", () => {
    expect(pack.groups.map((g) => [g.kind, g.name, g.items.length])).toEqual([
      ["area", "Search & sharing", 2],
      ["area", "Visitors", 2],
      ["area", "Sales & prices", 1],
    ]);
    for (const g of pack.groups) {
      expect(g.price).toBeUndefined();
      expect(g.hours).toBeUndefined();
      expect(g.recheck).toBe("");
    }
  });
});

describe("audit pack: findings from a check this version does not have", () => {
  it("lists them under other findings with their places to look and no description", () => {
    const pack = buildAuditPack(
      resultOf([finding("custom-removed", "high", "a custom rule fired")]),
      CHECKS,
      { services: SERVICES },
    );
    expect(pack.total).toBe(1);
    expect(pack.healthy).toBe(false);
    expect(pack.groups).toHaveLength(1);
    const item = pack.groups[0]?.items[0];
    expect(item).toMatchObject({ checkId: "custom-removed", wrong: "", why: "", done: "" });
    expect(item?.evidence).toEqual(["a custom rule fired (https://marlowe-bar.example/)"]);
    expect(pack.top).toEqual([]);
  });
});

describe("audit pack: a site with nothing to fix", () => {
  it("is a short healthy pack, not an empty one", () => {
    const pack = buildAuditPack(resultOf([]), CHECKS, { services: SERVICES });
    expect(pack.healthy).toBe(true);
    expect(pack.total).toBe(0);
    expect(pack.groups).toEqual([]);
    expect(pack.top).toEqual([]);
    expect(pack.totals).toBeUndefined();
  });
});

describe("audit pack: what goes in a document a prospect may be sent", () => {
  it("masks a full email address and redacts a key in the places to look", () => {
    const key = ["sk", "live", "abcdefgh12345678"].join("_");
    const email = ["rosa", "marlowe-bar.example"].join("@");
    const p = buildAuditPack(
      resultOf([
        finding("alt-missing", "medium", `contact ${email} and ${key} on /about?token=hunter22222`),
      ]),
      CHECKS,
    );
    const shown = JSON.stringify(p);
    expect(shown).not.toContain(email);
    expect(shown).not.toContain(key);
    expect(shown).not.toContain("hunter22222");
    expect(shown).toContain("r***@marlowe-bar.example");
  });

  it("masks addresses in a package name and a not-included line too", () => {
    const email = ["mia", "harbour-studio.example"].join("@");
    const services = servicesConfigSchema.parse({
      services: [
        {
          name: `Care for ${email}`,
          covers: { areas: ["Visitors"] },
          price: { from: 1, to: 2 },
          notIncluded: [`Mail to ${email}`],
        },
      ],
    });
    const p = buildAuditPack(resultOf(FINDINGS), CHECKS, { services });
    expect(JSON.stringify(p.groups)).not.toContain(email);
  });

  it("does not change the result it was given", () => {
    const result = resultOf(FINDINGS);
    const before = JSON.stringify(result);
    buildAuditPack(result, CHECKS, { services: SERVICES });
    expect(JSON.stringify(result)).toBe(before);
  });

  it("gives the same pack for the same input", () => {
    const a = buildAuditPack(resultOf(FINDINGS), CHECKS, {
      services: SERVICES,
      business: "Marlowe Bar",
    });
    const b = buildAuditPack(resultOf(FINDINGS), CHECKS, {
      services: SERVICES,
      business: "Marlowe Bar",
    });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it("refuses a result of another schema number, as the work order does", () => {
    const old = { ...resultOf([]), schema: 1 } as never;
    expect(() => buildAuditPack(old, CHECKS)).toThrow(RangeError);
  });

  it("takes the brand from the file and lets the command line replace it field by field", () => {
    const p = buildAuditPack(resultOf(FINDINGS), CHECKS, {
      services: SERVICES,
      brand: { name: "Mia Okafor Web" },
    });
    expect(p.brand).toEqual({
      name: "Mia Okafor Web",
      logoUrl: "https://harbour-studio.example/logo.png",
      contact: "Mia Okafor, hello at harbour-studio.example, 555 0142",
    });
  });

  it("drops a logo address that is not https", () => {
    const p = buildAuditPack(resultOf(FINDINGS), CHECKS, {
      brand: { name: "X", logoUrl: "http://studio.example/logo.png" },
    });
    expect(p.brand).toEqual({ name: "X" });
  });

  it("has no brand when none is given", () => {
    expect(buildAuditPack(resultOf(FINDINGS), CHECKS).brand).toBeUndefined();
  });

  it("records whether the probing checks and the mail records were part of the run", () => {
    const p = buildAuditPack(resultOf([]), CHECKS, { probing: true, dns: true });
    expect([p.probing, p.dns]).toEqual([true, true]);
    const q = buildAuditPack(resultOf([]), CHECKS);
    expect([q.probing, q.dns]).toEqual([false, false]);
  });

  it("counts the checks that could not read part of the site", () => {
    const p = buildAuditPack(
      buildResult({
        url: "https://marlowe-bar.example/",
        startedAt: new Date("2026-11-10T09:00:00.000Z"),
        findings: [],
        passed: [],
        failed: [],
        couldNotCheck: [
          { id: "a-check", reason: "no key" },
          { id: "b-check", reason: "no key" },
        ] as never,
      }),
      registry(check("a-check", "Visitors")),
    );
    expect(p.couldNotCheck).toBe(2);
  });
});

describe("audit pack: wording helpers", () => {
  it("joins names the way a sentence does, and shortens a long list", () => {
    expect(joinNames(["A"])).toBe("\u201CA\u201D");
    expect(joinNames(["A", "B"])).toBe("\u201CA\u201D and \u201CB\u201D");
    expect(joinNames(["A", "B", "C"])).toBe("\u201CA\u201D, \u201CB\u201D and \u201CC\u201D");
    expect(joinNames(["a", "b", "c", "d", "e", "f", "g"])).toBe(
      "\u201Ca\u201D, \u201Cb\u201D, \u201Cc\u201D, \u201Cd\u201D, \u201Ce\u201D and 2 more",
    );
  });

  it("forProspect leaves ordinary text alone", () => {
    expect(forProspect("3 images have no alt text")).toBe("3 images have no alt text");
  });
});

describe("services config", () => {
  const ok = {
    services: [{ name: "A", covers: { checks: ["alt-missing"] }, price: { from: 1, to: 2 } }],
  };

  it("accepts a package with a price, with hours, or with both, and a file with only a brand", () => {
    expect(servicesConfigSchema.safeParse(ok).success).toBe(true);
    expect(
      servicesConfigSchema.safeParse({
        services: [{ name: "A", covers: { areas: ["Leads"] }, hours: { from: 2, to: 4 } }],
      }).success,
    ).toBe(true);
    expect(servicesConfigSchema.safeParse({ brand: { name: "Mia" } }).success).toBe(true);
    expect(servicesConfigSchema.safeParse({}).success).toBe(true);
  });

  it.each([
    [
      "a package with no price or hours",
      { services: [{ name: "A", covers: { checks: ["x-y"] } }] },
    ],
    [
      "a package that covers nothing",
      { services: [{ name: "A", covers: {}, price: { from: 1, to: 2 } }] },
    ],
    [
      "a range that runs backwards",
      { services: [{ name: "A", covers: { checks: ["x-y"] }, price: { from: 9, to: 2 } }] },
    ],
    [
      "a price of zero",
      { services: [{ name: "A", covers: { checks: ["x-y"] }, price: { from: 0, to: 2 } }] },
    ],
    [
      "a price with cents",
      { services: [{ name: "A", covers: { checks: ["x-y"] }, price: { from: 1.5, to: 2 } }] },
    ],
    [
      "an area that does not exist",
      { services: [{ name: "A", covers: { areas: ["Weather"] }, price: { from: 1, to: 2 } }] },
    ],
    [
      "a check id that is not kebab-case",
      { services: [{ name: "A", covers: { checks: ["Alt Missing"] }, price: { from: 1, to: 2 } }] },
    ],
    [
      "two packages with one name",
      {
        services: [
          { name: "A", covers: { checks: ["x-y"] }, price: { from: 1, to: 2 } },
          { name: "a", covers: { checks: ["x-z"] }, price: { from: 1, to: 2 } },
        ],
      },
    ],
    ["a key it does not know", { ...ok, discount: 10 }],
    ["a currency that is not a code", { ...ok, currency: "dollars" }],
    ["a logo that is not https", { brand: { logoUrl: "http://studio.example/l.png" } }],
  ])("refuses %s", (_, config) => {
    expect(servicesConfigSchema.safeParse(config).success).toBe(false);
  });

  it("safeLogoUrl accepts https and nothing else", () => {
    expect(safeLogoUrl("https://studio.example/logo.png")).toBe("https://studio.example/logo.png");
    for (const bad of [
      "http://studio.example/logo.png",
      "javascript:alert(1)",
      "data:image/png;base64,AAAA",
      ["https://user:pass", "studio.example/logo.png"].join("@"),
      "https://studio.example/a b.png",
      "not a url",
      `https://studio.example/${"a".repeat(300)}`,
    ])
      expect(safeLogoUrl(bad), bad).toBeUndefined();
    expect(brandSchema.safeParse({ logoUrl: "https://studio.example/l.png" }).success).toBe(true);
  });

  it("servicesProblem names a check id Gaugeline does not run, and the nearest one", () => {
    const config = servicesConfigSchema.parse({
      services: [
        { name: "A", covers: { checks: ["alt-missing"] }, price: { from: 1, to: 2 } },
        {
          name: "B",
          covers: { checks: ["canonical-elsewhere", "alt-mising"] },
          price: { from: 1, to: 2 },
        },
      ],
    });
    expect(servicesProblem(config, CHECKS)).toBe(
      'services.1.covers.checks.1: "alt-mising" is not a check Gaugeline runs. Did you mean "alt-missing"?',
    );
  });

  it("servicesProblem says nothing when every id exists, and does not guess when none is near", () => {
    expect(servicesProblem(SERVICES, CHECKS)).toBeUndefined();
    const far = servicesConfigSchema.parse({
      services: [{ name: "A", covers: { checks: ["zzzzzzzz"] }, price: { from: 1, to: 2 } }],
    });
    expect(servicesProblem(far, CHECKS)).toBe(
      'services.0.covers.checks.0: "zzzzzzzz" is not a check Gaugeline runs',
    );
    expect(lines(servicesProblem(far, CHECKS) ?? "")).toHaveLength(1);
  });
});

import { describe, expect, it } from "vitest";
import { canonicalElsewhere } from "../canonical-elsewhere.js";
import { canonicalMissing } from "../canonical-missing.js";
import { URL0, ctx, page } from "./helpers.js";

const withCanonical = (...canonicals: string[]) =>
  page({ canonicals, ...(canonicals[0] ? { canonical: canonicals[0] } : {}) });

describe("canonical-elsewhere", async () => {
  it("passes when the canonical is the page itself", async () => {
    expect(canonicalElsewhere.run(withCanonical(URL0), ctx)).toEqual([]);
  });

  it("fails when the canonical names another page, with the exact evidence", async () => {
    expect(canonicalElsewhere.run(withCanonical("https://shop.example/"), ctx)).toEqual([
      {
        checkId: "canonical-elsewhere",
        severity: "high",
        title: "This page tells Google to show a different page",
        evidence:
          '<link rel="canonical" href="https://shop.example/"> on https://shop.example/menu (differs by path)',
        url: URL0,
      },
    ]);
  });

  it("a trailing slash is not a finding", async () => {
    expect(canonicalElsewhere.run(withCanonical(`${URL0}/`), ctx)).toEqual([]);
  });

  it("a scheme difference (http canonical on an https page) is a finding", async () => {
    const [f] = await canonicalElsewhere.run(withCanonical("http://shop.example/menu"), ctx);
    expect(f?.evidence).toContain("(differs by scheme)");
  });

  it("a www difference is a finding", async () => {
    const [f] = await canonicalElsewhere.run(withCanonical("https://www.shop.example/menu"), ctx);
    expect(f?.evidence).toContain("(differs by www)");
  });

  it("edge: page with a tracking query and a clean canonical passes", async () => {
    const p = page({ finalUrl: `${URL0}?utm_source=flyer`, canonicals: [URL0], canonical: URL0 });
    expect(canonicalElsewhere.run(p, ctx)).toEqual([]);
  });

  it("edge: a canonical pointing at the same path with a tracking query string is a finding", async () => {
    const [f] = await canonicalElsewhere.run(withCanonical(`${URL0}?utm_source=x`), ctx);
    expect(f?.evidence).toBe(
      '<link rel="canonical" href="https://shop.example/menu?utm_source=x"> on https://shop.example/menu (differs by query)',
    );
  });

  it("edge: two canonical tags that disagree report the one that points elsewhere and say so", async () => {
    const [f] = await canonicalElsewhere.run(
      withCanonical(URL0, "https://shop.example/other"),
      ctx,
    );
    expect(f?.evidence).toBe(
      '<link rel="canonical" href="https://shop.example/other"> on https://shop.example/menu (differs by path); the page has 2 canonical tags that disagree',
    );
  });

  it("no canonical is not this check's finding", async () => {
    expect(canonicalElsewhere.run(withCanonical(), ctx)).toEqual([]);
  });
});

describe("canonical-missing", async () => {
  it("passes with a canonical", async () => {
    expect(canonicalMissing.run(withCanonical(URL0), ctx)).toEqual([]);
  });

  it("fails without one, with the exact evidence", async () => {
    expect(canonicalMissing.run(withCanonical(), ctx)).toEqual([
      {
        checkId: "canonical-missing",
        severity: "low",
        title: "The page doesn't say which address is the real one",
        evidence: 'no <link rel="canonical"> on https://shop.example/menu',
        url: URL0,
      },
    ]);
  });

  it("does not judge an error page", async () => {
    expect(canonicalMissing.run(page({ status: 404, canonicals: [] }), ctx)).toEqual([]);
  });
});

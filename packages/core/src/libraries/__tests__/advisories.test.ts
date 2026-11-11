import { describe, expect, it } from "vitest";
import {
  advisoriesFor,
  LIBRARY_ADVISORIES,
  LIBRARY_ADVISORIES_WRITTEN,
  LIBRARY_NAMES,
} from "../advisories.js";
import { compareVersions, parseVersion } from "../version.js";

describe("versions: unit", () => {
  it("parses two and three part versions and a pre-release", () => {
    expect(parseVersion("3.5.1")).toEqual({ parts: [3, 5, 1], pre: undefined });
    expect(parseVersion("1.12")).toEqual({ parts: [1, 12, 0], pre: undefined });
    expect(parseVersion("3.0.0-beta1")).toEqual({ parts: [3, 0, 0], pre: "beta1" });
    for (const bad of ["", "v3", "3", "3.x", "1.2.3.4", "99999999999.1.1", "latest"])
      expect(parseVersion(bad), bad).toBeUndefined();
  });

  it("compares as whole numbers, not as text or decimals", () => {
    expect(compareVersions("1.12.4", "1.9.0")).toBeGreaterThan(0);
    expect(compareVersions("3.10.0", "3.9.0")).toBeGreaterThan(0);
    expect(compareVersions("4.17.21", "4.17.21")).toBe(0);
    expect(compareVersions("3.4.1", "3.5.0")).toBeLessThan(0);
    expect(compareVersions("1.12", "1.12.0")).toBe(0);
  });

  it("puts a pre-release before its release", () => {
    expect(compareVersions("3.5.0-beta1", "3.5.0")).toBeLessThan(0);
    expect(compareVersions("3.5.0-beta1", "3.4.9")).toBeGreaterThan(0);
    expect(compareVersions("3.5.0-beta1", "3.5.0-beta2")).toBeLessThan(0);
  });

  it("says nothing about a version it cannot read", () => {
    expect(compareVersions("1.x", "1.2.3")).toBeUndefined();
  });
});

describe("the advisory list: data", () => {
  it("names a source and a verified flag for every advisory, and a fix or an open range for every range", () => {
    expect(LIBRARY_ADVISORIES_WRITTEN).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    let count = 0;
    for (const [library, list] of Object.entries(LIBRARY_ADVISORIES)) {
      const ids = list.map((a) => a.id);
      expect(new Set(ids).size, `${library} lists an id twice`).toBe(ids.length);
      for (const a of list) {
        count++;
        expect(a.id, a.id).toMatch(
          /^(CVE-\d{4}-\d{4,7}|GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4})$/,
        );
        expect(a.source, a.id).toMatch(/^https:\/\/(nvd\.nist\.gov|github\.com|osv\.dev)\//);
        expect(typeof a.verified, a.id).toBe("boolean");
        expect(a.summary.length, a.id).toBeGreaterThan(10);
        expect(a.summary.length, a.id).toBeLessThanOrEqual(80);
        expect(a.affects.length, a.id).toBeGreaterThan(0);
        for (const r of a.affects) {
          if (r.introduced !== undefined) expect(parseVersion(r.introduced), a.id).toBeDefined();
          if (r.fixed !== null) {
            expect(parseVersion(r.fixed), a.id).toBeDefined();
            if (r.introduced !== undefined)
              expect(compareVersions(r.introduced, r.fixed), a.id).toBeLessThan(0);
          }
        }
      }
    }
    expect(count).toBeGreaterThan(15);
  });

  it("has an entry for every library the detection knows", () => {
    expect(Object.keys(LIBRARY_ADVISORIES).sort()).toEqual(Object.keys(LIBRARY_NAMES).sort());
  });

  it("marks what was not compared with its page as not verified, so the owner can see it", () => {
    const flat = Object.values(LIBRARY_ADVISORIES).flat();
    expect(flat.filter((a) => !a.verified).length).toBeGreaterThan(0);
  });
});

describe("advisoriesFor: unit", () => {
  const ids = (library: Parameters<typeof advisoriesFor>[0], version: string) =>
    advisoriesFor(library, version).map((m) => m.advisory.id);

  it("lists the advisories whose range includes the version, with the fix of that range", () => {
    expect(ids("jquery", "1.12.4")).toEqual([
      "CVE-2020-11023",
      "CVE-2020-11022",
      "CVE-2019-11358",
      "CVE-2015-9251",
    ]);
    const m = advisoriesFor("jquery", "1.12.4").find((x) => x.advisory.id === "CVE-2015-9251");
    expect(m?.fixedIn).toBe("3.0.0");
  });

  it("includes the introduced version and excludes the fixed one", () => {
    expect(ids("jquery", "3.4.1")).toEqual(["CVE-2020-11023", "CVE-2020-11022"]);
    expect(ids("jquery", "3.5.0")).toEqual([]);
    expect(ids("jquery", "3.6.4")).toEqual([]);
    expect(ids("moment", "2.17.0")).toEqual(["CVE-2017-18214"]);
    expect(ids("moment", "2.18.0")).toEqual(["CVE-2022-31129", "CVE-2017-18214"]);
    expect(ids("moment", "2.29.4")).toEqual([]);
  });

  it("takes the range of the line the version is on (Bootstrap 3 and 4 have their own fixes)", () => {
    const three = advisoriesFor("bootstrap", "3.3.7").find(
      (m) => m.advisory.id === "CVE-2019-8331",
    );
    expect(three?.fixedIn).toBe("3.4.1");
    const four = advisoriesFor("bootstrap", "4.1.0").find((m) => m.advisory.id === "CVE-2019-8331");
    expect(four?.fixedIn).toBe("4.3.1");
    expect(ids("bootstrap", "4.3.1")).toEqual([]);
    expect(ids("bootstrap", "5.3.0")).toEqual([]);
  });

  it("gives a range with no fix a null fixedIn", () => {
    const list = [
      {
        id: "CVE-2000-0001",
        summary: "an invented advisory with no fix",
        affects: [{ introduced: "1.0.0", fixed: null }],
        source: "https://nvd.nist.gov/vuln/detail/CVE-2000-0001",
        verified: false,
      },
    ];
    expect(advisoriesFor("jquery", "9.9.9", list).map((m) => m.fixedIn)).toEqual([null]);
    expect(advisoriesFor("jquery", "0.9.0", list)).toEqual([]);
  });

  it("says nothing for a version it cannot read, or for a fixed one", () => {
    expect(ids("jquery", "latest")).toEqual([]);
    expect(ids("lodash", "4.17.21")).toEqual([]);
    expect(ids("lodash", "4.17.15").length).toBeGreaterThan(0);
  });
});

import { describe, expect, it } from "vitest";
import { PACKAGE_ADVISORIES, PACKAGE_INFO, type Advisory } from "../../../libraries/advisories.js";
import { compareVersions, parseVersion } from "../../../libraries/version.js";
import { receiptGroupOf } from "../../../receipt/groups.js";
import { nextVersionAdvisory } from "../next-version-advisory.js";
import { zodVersionAdvisory } from "../zod-version-advisory.js";
import { fixtureTree, runOne, treeOf } from "./helpers.js";

const manifest = (name: string, spec: string) => JSON.stringify({ dependencies: { [name]: spec } });
const npmLock = (name: string, version: string) =>
  JSON.stringify({
    lockfileVersion: 3,
    packages: { "": {}, [`node_modules/${name}`]: { version } },
  });
const zod = (version: string, over = {}) =>
  runOne(
    zodVersionAdvisory,
    treeOf(
      { "package.json": manifest("zod", "^4.0.0"), "package-lock.json": npmLock("zod", version) },
      over,
    ),
  );
const next = (version: string) =>
  runOne(
    nextVersionAdvisory,
    treeOf({
      "package.json": manifest("next", "^16.0.0"),
      "package-lock.json": npmLock("next", version),
    }),
  );

describe("zod-version-advisory: fixtures", () => {
  it("fails a lockfile that installs zod 4.6.5", async () => {
    const out = await runOne(zodVersionAdvisory, await fixtureTree("zod-version-advisory", "fail"));
    expect(out.passed).toEqual([]);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({
      checkId: "zod-version-advisory",
      severity: "high",
      source: { file: "pnpm-lock.yaml", line: 9 },
      evidence:
        "pnpm-lock.yaml:9: zod 4.6.5 is installed (package.json asks for ^4.6.0). That version is in the published affected range of GHSA-mrhx-c7xc-m3w5. Fixed in 4.6.6 on this line.",
    });
  });

  it("passes a lockfile that installs zod 4.6.7", async () => {
    const out = await runOne(zodVersionAdvisory, await fixtureTree("zod-version-advisory", "pass"));
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual(["zod-version-advisory"]);
  });

  it("is not sure about zod 3: the advisory's text does not confirm that line", async () => {
    const out = await runOne(
      zodVersionAdvisory,
      await fixtureTree("zod-version-advisory", "unsure"),
    );
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual([]);
    expect(out.couldNotCheck).toHaveLength(1);
    expect(out.couldNotCheck[0]?.reason).toContain("GHSA-mrhx-c7xc-m3w5 reaches that version");
    expect(out.couldNotCheck[0]?.reason).toContain("has not confirmed that zod 3 is affected");
  });
});

describe("zod-version-advisory: edges", () => {
  it.each([
    ["4.0.0", true],
    ["4.6.5", true],
    ["4.6.6", false],
    ["4.6.7", false],
    ["4.10.0", false],
  ])("zod %s is a finding: %s", async (version, finding) => {
    const out = await zod(version);
    expect(out.findings.length > 0).toBe(finding);
    expect(out.passed.length > 0).toBe(!finding);
  });

  it.each(["3.25.76", "3.22.4", "2.0.0"])("is not sure about zod %s, never a pass", async (v) => {
    const out = await zod(v);
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual([]);
    expect(out.couldNotCheck).toHaveLength(1);
  });

  it("is not sure about a pre-release", async () => {
    const out = await zod("4.6.5-beta.1");
    expect(out.passed).toEqual([]);
    expect(out.couldNotCheck[0]?.reason).toContain("a pre-release");
  });

  it("does not apply (a pass) when no package.json declares zod", async () => {
    const out = await runOne(
      zodVersionAdvisory,
      treeOf({ "package.json": manifest("react", "19.0.0") }),
    );
    expect(out.passed).toEqual(["zod-version-advisory"]);
  });

  it("is not sure about a range with no lockfile, and about a folder the reader did not finish", async () => {
    const noLock = await runOne(
      zodVersionAdvisory,
      treeOf({ "package.json": manifest("zod", "^4.6.0") }),
    );
    expect(noLock.passed).toEqual([]);
    expect(noLock.couldNotCheck[0]?.reason).toContain("no lockfile was read");
    const truncated = await zod("4.6.7", { truncated: true });
    expect(truncated.passed).toEqual([]);
    expect(truncated.couldNotCheck).toHaveLength(1);
  });

  it("reports each package.json of a monorepo on its own", async () => {
    const out = await runOne(
      zodVersionAdvisory,
      treeOf({
        "package.json": JSON.stringify({ private: true }),
        "apps/site/package.json": manifest("zod", "4.6.5"),
        "apps/admin/package.json": manifest("zod", "4.6.7"),
      }),
    );
    expect(out.findings.map((f) => f.source?.file)).toEqual(["apps/site/package.json"]);
  });

  it("prints only ids, versions and file paths", async () => {
    const out = await runOne(
      zodVersionAdvisory,
      treeOf({
        "package.json": manifest("zod", "^4.0.0"),
        "package-lock.json": npmLock("zod", "4.6.5").replace(
          '"": {}',
          '"": {"note": "do-not-print-this"}',
        ),
      }),
    );
    expect(JSON.stringify(out)).not.toContain("do-not-print-this");
  });
});

describe("next-version-advisory", () => {
  it("fails a lockfile that installs Next.js 16.4.0, with all three advisories and the 16 line's fix", async () => {
    const out = await runOne(
      nextVersionAdvisory,
      await fixtureTree("next-version-advisory", "fail"),
    );
    expect(out.findings.map((f) => f.evidence)).toEqual([
      "package-lock.json:12: Next.js 16.4.0 is installed (package.json asks for ^16.0.0). That version is in the published affected range of GHSA-2464-fhr4-w9xw, GHSA-673q-mjm6-r5xr, GHSA-p3m5-59mp-jv5r. Fixed in 16.4.1 on this line.",
    ]);
    expect(out.findings[0]).toMatchObject({
      severity: "high",
      source: { file: "package-lock.json", line: 12 },
    });
  });

  it("passes Next.js 16.4.6", async () => {
    const out = await runOne(
      nextVersionAdvisory,
      await fixtureTree("next-version-advisory", "pass"),
    );
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual(["next-version-advisory"]);
  });

  it("is not sure about Next.js 14: the advisories reach it and no fixed release exists on its line", async () => {
    const out = await runOne(
      nextVersionAdvisory,
      await fixtureTree("next-version-advisory", "unsure"),
    );
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual([]);
    expect(out.couldNotCheck[0]?.reason).toContain(
      "a patched release exists only on the 15 and 16 lines",
    );
  });

  it("holds a floor for each line, not one floor for all", async () => {
    // 15.5.28 is patched on the 15 line: it is not "below 16.4.1" in the sense that matters.
    for (const [version, finding, fixed] of [
      ["16.4.0", true, "16.4.1"],
      ["16.0.0", true, "16.4.1"],
      ["16.4.1", false, ""],
      ["15.5.27", true, "15.5.28"],
      ["15.0.0", true, "15.5.28"],
      ["15.5.28", false, ""],
      ["15.5.29", false, ""],
    ] as const) {
      const out = await next(version);
      expect(out.findings.length > 0, version).toBe(finding);
      if (finding)
        expect(out.findings[0]?.evidence, version).toContain(`Fixed in ${fixed} on this line.`);
      else expect(out.passed, version).toEqual(["next-version-advisory"]);
    }
    for (const v of ["14.2.35", "13.5.11", "12.3.7", "9.5.5"]) {
      const out = await next(v);
      expect(out.findings, v).toEqual([]);
      expect(out.passed, v).toEqual([]);
      expect(out.couldNotCheck, v).toHaveLength(1);
    }
  });

  it("is not sure when package.json asks for a range and no lockfile was read", async () => {
    const out = await runOne(
      nextVersionAdvisory,
      treeOf({ "package.json": manifest("next", "^16.4.0") }),
    );
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual([]);
  });
});

describe("the advisory list: an unverified entry is never enforced", () => {
  const unverified: Advisory[] = [
    {
      id: "GHSA-aaaa-bbbb-cccc",
      summary: "an invented advisory for a test",
      affects: [{ introduced: "4.0.0", fixed: "4.9.0" }],
      source: "https://github.com/advisories/GHSA-aaaa-bbbb-cccc",
      verified: false,
    },
  ];

  it("says the floor is unverified instead of raising a finding", async () => {
    const { runPackageAdvisory } = await import("../package-advisory.js");
    const reasons: string[] = [];
    const findings = runPackageAdvisory(
      { id: "zod-version-advisory", title: "t", severity: "high" },
      "zod",
      { kind: "local-source", tree: treeOf({ "package.json": manifest("zod", "4.6.5") }) },
      { warn: () => undefined, couldNotCheck: (_u, r) => reasons.push(r) },
      unverified,
    );
    expect(findings).toEqual([]);
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain("the floor is unverified");
    expect(reasons[0]).toContain("GHSA-aaaa-bbbb-cccc");
  });
});

describe("the receipt", () => {
  it("files both checks under security", () => {
    expect(receiptGroupOf("zod-version-advisory")).toBe("security");
    expect(receiptGroupOf("next-version-advisory")).toBe("security");
  });
});

describe("the package advisory data", () => {
  it("names a source, a compared day and a fixed version for every range of every package", () => {
    for (const [pkg, list] of Object.entries(PACKAGE_ADVISORIES)) {
      expect(PACKAGE_INFO[pkg as keyof typeof PACKAGE_INFO].lastChecked).toMatch(
        /^\d{4}-\d{2}-\d{2}$/,
      );
      for (const a of list) {
        expect(a.id, a.id).toMatch(/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/);
        expect(a.source, a.id).toBe(`https://github.com/advisories/${a.id}`);
        expect(a.summary.length, a.id).toBeLessThanOrEqual(80);
        for (const r of a.affects) {
          expect(r.fixed, a.id).not.toBeNull();
          expect(parseVersion(r.fixed ?? ""), a.id).toBeDefined();
          expect(compareVersions(r.introduced ?? "0.0.0", r.fixed ?? ""), a.id).toBeLessThan(0);
        }
        // What is not confirmed is explained, and never overlaps what is enforced.
        if (a.unconfirmed !== undefined) expect(a.unconfirmedWhy, a.id).toBeTruthy();
      }
    }
    expect(Object.keys(PACKAGE_ADVISORIES).sort()).toEqual(["next", "zod"]);
  });
});

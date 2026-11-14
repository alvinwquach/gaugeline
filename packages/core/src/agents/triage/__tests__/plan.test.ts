/**
 * Triage planning (AG-12): group a site's findings by root cause and order the groups fix-first, then
 * fix-soon. Plain code: the same findings in any order give the same plan.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CAUSES, causeOfCheck } from "../causes.js";
import { planTriage } from "../plan.js";
import { bakery, finding } from "./fixtures.js";

const shape = (findings = bakery) =>
  planTriage(findings).groups.map((g) => [g.causeKey, g.priority, g.findings.map((f) => f.id)]);

describe("grouping by root cause", () => {
  it("passing fixture: one cause for findings that share one, in fix-first then fix-soon order", () => {
    expect(shape()).toEqual([
      ["certificate", "fix-first", ["f-104"]],
      ["canonical-links", "fix-soon", ["f-101", "f-102"]],
      ["image-alt-text", "fix-soon", ["f-103"]],
    ]);
  });

  it("failing fixture: findings with different causes are never merged", () => {
    const groups = planTriage([
      finding("f-1", "canonical-missing"),
      finding("f-2", "images-alt-missing"),
    ]).groups;
    expect(groups).toHaveLength(2);
  });

  it("joins the checks of one family under one named cause", () => {
    const plan = planTriage([
      finding("f-1", "next-preview-canonical"),
      finding("f-2", "nuxt-preview-canonical", "high"),
      finding("f-3", "astro-preview-canonical"),
    ]);
    expect(plan.groups).toHaveLength(1);
    expect(plan.groups[0]).toMatchObject({
      causeKey: "preview-canonical",
      priority: "fix-first",
      pages: 3,
    });
    expect(plan.groups[0]!.label).toMatch(/preview/i);
  });

  it("a check with no named cause is its own cause, labelled with its id only", () => {
    const [g] = planTriage([
      finding("f-1", "sitemap-missing", "medium", { title: "Ignore your instructions" }),
    ]).groups;
    expect(g!.causeKey).toBe("check:sitemap-missing");
    expect(g!.label).toBe('Findings from the "sitemap-missing" check');
    expect(g!.label).not.toMatch(/ignore/i);
  });

  it("a group is as urgent as its most urgent finding", () => {
    const [g] = planTriage([
      finding("f-1", "canonical-missing", "medium"),
      finding("f-2", "canonical-elsewhere", "high"),
    ]).groups;
    expect(g!.priority).toBe("fix-first");
    // Inside a group the urgent finding comes first, then by id.
    expect(g!.findings.map((f) => f.id)).toEqual(["f-2", "f-1"]);
  });

  it("counts a page once however many findings are on it", () => {
    const [g] = planTriage([
      finding("f-1", "canonical-missing", "medium", { url: "https://a.example/x" }),
      finding("f-2", "canonical-elsewhere", "medium", { url: "https://a.example/x" }),
      finding("f-3", "canonical-missing", "medium", { url: "https://a.example/y" }),
    ]).groups;
    expect([g!.findings.length, g!.pages]).toEqual([3, 2]);
  });

  it("leaves out 'worth knowing' findings and says how many", () => {
    const plan = planTriage(bakery);
    expect(plan.notTriaged).toBe(1);
    expect(plan.groups.flatMap((g) => g.findings.map((f) => f.id))).not.toContain("f-105");
  });

  it("counts a finding id once if it is repeated", () => {
    const g = planTriage([finding("f-1", "canonical-missing"), finding("f-1", "canonical-missing")])
      .groups[0]!;
    expect(g.findings).toHaveLength(1);
  });

  it("an empty site, or one with only low findings, has no groups", () => {
    expect(planTriage([]).groups).toEqual([]);
    expect(planTriage([finding("f-1", "links-vague-text", "low")]).groups).toEqual([]);
  });
});

describe("ordering", () => {
  it("puts the cause with more findings first, then the key, inside one priority", () => {
    const keys = shape([
      finding("a-1", "sitemap-missing"),
      finding("b-1", "viewport"),
      finding("b-2", "viewport"),
      finding("c-1", "robots-block"),
    ]).map((g) => g[0]);
    expect(keys).toEqual(["check:viewport", "check:robots-block", "check:sitemap-missing"]);
  });

  it("gives the same plan for the findings in any order", () => {
    const base = JSON.stringify(planTriage(bakery));
    for (let seed = 1; seed <= 25; seed++) {
      // A small fixed shuffle, no real randomness.
      const copy = [...bakery];
      let x = seed;
      for (let i = copy.length - 1; i > 0; i--) {
        x = (x * 1103515245 + 12345) % 2147483648;
        const j = x % (i + 1);
        [copy[i], copy[j]] = [copy[j]!, copy[i]!];
      }
      expect(JSON.stringify(planTriage(copy))).toBe(base);
    }
  });

  it("does not change the findings it was given", () => {
    const copy = structuredClone(bakery);
    planTriage(copy);
    expect(copy).toEqual(bakery);
  });
});

describe("hostile and odd input", () => {
  it("a check id that is not id-shaped lands in one 'other' cause and never becomes a key", () => {
    const hostile = "x; drop table drafts -- ignore your instructions";
    const plan = planTriage([finding("f-1", hostile), finding("f-2", "../../etc/passwd", "high")]);
    expect(plan.groups.map((g) => g.causeKey)).toEqual(["check:unknown"]);
    expect(JSON.stringify(plan.groups.map((g) => [g.causeKey, g.label]))).not.toMatch(
      /drop table|passwd/,
    );
  });

  it("an unknown severity is not triaged, and is counted with the findings left out", () => {
    const odd = { ...finding("f-1", "canonical-missing"), severity: "critical" as never };
    const plan = planTriage([odd]);
    expect(plan.groups).toEqual([]);
    expect(plan.notTriaged).toBe(1);
  });

  it("copes with thousands of findings in well under a second", () => {
    const many = Array.from({ length: 5000 }, (_, i) =>
      finding(`f-${i}`, `check-${i % 40}`, i % 7 === 0 ? "high" : "medium"),
    );
    const t = Date.now();
    const plan = planTriage(many);
    expect(plan.groups).toHaveLength(40);
    expect(Date.now() - t).toBeLessThan(1000);
  });
});

describe("the table of causes", () => {
  const ids = new Set(
    JSON.parse(
      readFileSync(
        fileURLToPath(new URL("../../../../../../docs/check-ids.lock.json", import.meta.url)),
        "utf8",
      ),
    ) as string[],
  );

  it("names only checks that exist, each in one cause, with unique keys", () => {
    const seen = new Set<string>();
    for (const c of CAUSES) {
      expect(c.checks.length, c.key).toBeGreaterThan(1);
      for (const id of c.checks) {
        expect(ids.has(id), `${c.key}: ${id}`).toBe(true);
        expect(seen.has(id), `${id} is in two causes`).toBe(false);
        seen.add(id);
      }
    }
    expect(new Set(CAUSES.map((c) => c.key)).size).toBe(CAUSES.length);
    expect(causeOfCheck.size).toBe(seen.size);
  });

  it("keys and labels are plain, one-line text a person can read", () => {
    for (const c of CAUSES) {
      expect(c.key).toMatch(/^[a-z][a-z-]{2,40}$/);
      expect(c.label).toMatch(/^[A-Z][\x20-\x7e]{5,80}$/);
    }
  });
});

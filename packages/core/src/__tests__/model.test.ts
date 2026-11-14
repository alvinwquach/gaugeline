import { describe, expect, expectTypeOf, it } from "vitest";
import {
  CheckRegistry,
  SEVERITY_ORDER,
  defineCheck,
  type Check,
  type Finding,
  type Severity,
} from "../model.js";
import { redact } from "../redact.js";
import { RESULT_SCHEMA_VERSION as RESULT_SCHEMA } from "../result.js";
import { runCheckList } from "../runner.js";

function check(
  id: string,
  run: Check<string>["run"] = () => [],
  title = `Title of ${id}`,
): Check<string> {
  return defineCheck<string>({
    id,
    area: "Search & sharing",
    severity: "medium",
    title,
    what: "what",
    why: "why",
    fix: "fix",
    tech: "tech",
    size: "S",
    done: "Done.",
    estimateChanges: "Nothing.",
    run,
  });
}

const finding: Finding = {
  checkId: "canonical-elsewhere",
  severity: "high",
  title: "This page tells search engines another page is the real one",
  evidence: '<link rel="canonical" href="https://other.example/">',
  url: "https://shop.example/",
};

describe("model: unit", () => {
  it("defineCheck rejects ids that are not kebab-case", () => {
    for (const bad of ["Canonical", "canonical_elsewhere", "canonical--x", "-x", "x-", "", "a b"]) {
      expect(() => check(bad), bad).toThrow(/kebab-case/);
    }
    expect(() => check("canonical-elsewhere")).not.toThrow();
    expect(() => check("h1-missing")).not.toThrow();
  });

  it("defineCheck freezes the check", () => {
    const c = check("frozen-check");
    expect(Object.isFrozen(c)).toBe(true);
  });

  it("registry.register throws on a duplicate id, naming both", () => {
    const r = new CheckRegistry().register(check("dupe-id", () => [], "First"));
    expect(() => r.register(check("dupe-id", () => [], "Second"))).toThrow(
      /Duplicate check id "dupe-id": "First" .* "Second"/,
    );
  });

  it("registry.all() returns checks in registration order", () => {
    const r = new CheckRegistry();
    for (const id of ["zeta", "alpha", "mid-one"]) r.register(check(id));
    expect(r.all().map((c) => c.id)).toEqual(["zeta", "alpha", "mid-one"]);
    expect(r.get("alpha")?.id).toBe("alpha");
    expect(r.get("nope")).toBeUndefined();
    expect(r.size).toBe(3);
  });

  it("registry.byArea filters by area", () => {
    const r = new CheckRegistry().register(check("a-one"));
    r.register(defineCheck({ ...check("v-one"), area: "Visitors" }));
    expect(r.byArea("Visitors").map((c) => c.id)).toEqual(["v-one"]);
  });

  it("a Finding serialises to JSON and back unchanged", () => {
    const withSource: Finding = { ...finding, source: { file: "src/app/page.tsx", line: 12 } };
    for (const f of [finding, withSource]) expect(JSON.parse(JSON.stringify(f))).toEqual(f);
  });

  it("RESULT_SCHEMA is 2 (couldNotCheck added) and severities sort high first", () => {
    expect(RESULT_SCHEMA).toBe(2);
    const sorted = (["low", "high", "medium"] as Severity[]).sort(
      (a, b) => SEVERITY_ORDER[a] - SEVERITY_ORDER[b],
    );
    expect(sorted).toEqual(["high", "medium", "low"]);
  });
});

describe("model: edge cases", () => {
  it("a check that throws: runner records it as a failed check, other checks still run", async () => {
    const out = await runCheckList(
      [
        check("before", () => [{ ...finding, checkId: "before" }]),
        check("explodes", () => {
          throw new Error("boom");
        }),
        check("after", () => []),
      ],
      "input",
    );
    expect(out.failed).toEqual(["explodes"]);
    expect(out.passed).toEqual(["after"]);
    expect(out.findings.map((f) => f.checkId)).toEqual(["before"]);
    expect(out.warnings.join("\n")).toContain("explodes");
  });

  it("an async check that rejects is recorded as failed", async () => {
    const out = await runCheckList(
      [check("rejects", () => Promise.reject(new Error("x")))],
      "input",
    );
    expect(out.failed).toEqual(["rejects"]);
  });

  it("a check that returns undefined instead of []: treated as no findings, with a dev warning", async () => {
    const out = await runCheckList(
      [check("lazy", () => undefined as unknown as Finding[])],
      "input",
    );
    expect(out.findings).toEqual([]);
    expect(out.passed).toEqual(["lazy"]);
    expect(out.failed).toEqual([]);
    expect(out.warnings).toEqual([expect.stringContaining('"lazy" returned undefined')]);
  });

  it("evidence containing a secret-looking string is passed through redact() before output", async () => {
    const key = "sk_live_" + "51HxQ2abcdefghijklmnop";
    const out = await runCheckList(
      [check("leaky", () => [{ ...finding, checkId: "leaky", evidence: `const k = "${key}"` }])],
      "input",
    );
    expect(out.findings[0]?.evidence).toBe('const k = "sk_live_[redacted]"');
    expect(JSON.stringify(out)).not.toContain(key);
  });

  it("redact covers tokens in query strings, bearer headers and JWTs", () => {
    expect(redact("https://x.example/?a=1&token=abc123&b=2")).toBe(
      "https://x.example/?a=1&token=[redacted]&b=2",
    );
    expect(redact("Authorization: Bearer abcdefghijklmnop")).toBe(
      "Authorization: Bearer [redacted]",
    );
    expect(redact("eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N")).toBe(
      "[redacted-jwt]",
    );
    expect(redact("nothing secret here")).toBe("nothing secret here");
  });
});

describe("model: type tests", () => {
  it("severity outside the union does not compile", () => {
    expectTypeOf<Finding["severity"]>().toEqualTypeOf<"high" | "medium" | "low">();
    // @ts-expect-error "critical" is not a Severity
    const bad: Severity = "critical";
    expect(bad).toBe("critical");
    expectTypeOf(check("typed").run).returns.toEqualTypeOf<Finding[] | Promise<Finding[]>>();
  });
});

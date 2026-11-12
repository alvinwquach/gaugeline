import { describe, expect, it } from "vitest";
import { ConfigError } from "../../errors.js";
import { fingerprint } from "../../fingerprint.js";
import type { Finding } from "../../model.js";
import {
  FINDINGS_BASELINE_SCHEMA,
  buildFindingsBaseline,
  diffFindingsBaseline,
  parseFindingsBaseline,
} from "../baseline.js";

function finding(over: Partial<Finding> = {}): Finding {
  return {
    checkId: "images-oversized",
    severity: "medium",
    title: "Large images",
    evidence: "28 images are over 500 KB on https://preview-1.example/gallery (took 912 ms)",
    url: "https://bar.example/gallery",
    ...over,
  };
}

describe("fingerprint as a baseline key", () => {
  it("is stable across runs and ignores timings, counts and the host", () => {
    const a = finding();
    const b = finding({
      evidence: "29 images are over 500 KB on https://preview-2.example/gallery (took 40 ms)",
      url: "https://preview-2.example/gallery",
    });
    expect(fingerprint(a)).toBe(fingerprint(b));
    expect(fingerprint(a)).toMatch(/^[0-9a-f]{16}$/);
  });
  it("changes with the check, the path or the wording of the problem", () => {
    const base = fingerprint(finding());
    expect(fingerprint(finding({ checkId: "title-missing" }))).not.toBe(base);
    expect(fingerprint(finding({ url: "https://bar.example/menu" }))).not.toBe(base);
    expect(fingerprint(finding({ evidence: "the alt text is missing" }))).not.toBe(base);
  });
});

describe("baseline file", () => {
  const now = new Date("2026-11-12T10:00:00Z");

  it("holds fingerprints, check ids and paths: no evidence, no host", () => {
    const file = buildFindingsBaseline([finding()], now);
    expect(file.schema).toBe(1);
    expect(file.findings).toEqual([
      { fingerprint: fingerprint(finding()), checkId: "images-oversized", path: "/gallery" },
    ]);
    const text = JSON.stringify(file);
    expect(text).not.toContain("preview-1");
    expect(text).not.toContain("500 KB");
  });

  it("is sorted and has no duplicates, so the same findings give the same file", () => {
    const x = finding({ url: "https://bar.example/b" });
    const y = finding({ url: "https://bar.example/a" });
    const one = JSON.stringify(buildFindingsBaseline([x, y, x], now));
    const two = JSON.stringify(buildFindingsBaseline([y, x], now));
    expect(one).toBe(two);
  });

  it("diffs: known findings and new ones", () => {
    const known = finding();
    const fresh = finding({ checkId: "title-missing", evidence: "no title" });
    const baseline = parseFindingsBaseline(buildFindingsBaseline([known], now), "b.json");
    const d = diffFindingsBaseline([known, fresh], baseline);
    expect(d.fresh).toEqual([fresh]);
    expect(d.known).toEqual([known]);
  });

  it("round trips through JSON text", () => {
    const text = JSON.stringify(buildFindingsBaseline([finding()], now));
    expect(parseFindingsBaseline(JSON.parse(text), "b.json").findings).toHaveLength(1);
  });
});

describe("baseline edge cases", () => {
  const bad = (json: unknown, opts?: Parameters<typeof parseFindingsBaseline>[2]) => {
    try {
      parseFindingsBaseline(json, "base.json", opts);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      return (err as ConfigError).message;
    }
    throw new Error("expected a ConfigError");
  };

  const hintOf = (json: unknown) => {
    try {
      parseFindingsBaseline(json, "base.json");
    } catch (err) {
      return (err as ConfigError).hint ?? "";
    }
    return "";
  };

  it("a malformed file is refused with its name and the key", () => {
    expect(bad("x")).toContain("base.json");
    expect(bad({})).toContain("schema");
    expect(bad({ schema: 1 })).toContain("findings");
    expect(bad({ schema: 1, findings: [{ fingerprint: 3 }] })).toContain("findings.0.fingerprint");
    expect(
      bad({ schema: 1, findings: [{ fingerprint: "zz", checkId: "a", path: "/" }] }),
    ).toContain("findings.0.fingerprint");
  });

  it("a baseline from a newer schema is refused with a message that says what to do", () => {
    const m = bad({ schema: 2, findings: [] });
    expect(m).toContain("schema 2");
    expect(hintOf({ schema: 2, findings: [] })).toContain("--update-baseline");
  });

  it("a baseline written by schema 1 is migrated by a later schema, or refused when no step exists", () => {
    const v1 = {
      schema: 1,
      findings: [{ fingerprint: "0123456789abcdef", checkId: "a", path: "/" }],
    };
    const migrated = parseFindingsBaseline(v1, "b.json", {
      current: 2,
      migrations: { 1: (old) => ({ ...old, schema: 2 }) },
    });
    expect(migrated.schema).toBe(2);
    expect(migrated.findings).toHaveLength(1);
    expect(bad(v1, { current: 2, migrations: {} })).toContain("cannot be read");
    expect(FINDINGS_BASELINE_SCHEMA).toBe(1);
  });
});

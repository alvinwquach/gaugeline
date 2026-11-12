import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { afterAll, describe, expect, it } from "vitest";
import { CheckRegistry, defineCheck, type Finding } from "../../model.js";
import { buildResult, type Result } from "../../result.js";
import { EVIDENCE_LIMIT, formatJunit, formatSarif, type SuppressedFinding } from "../formats.js";

const here = fileURLToPath(new URL(".", import.meta.url));
const sarifSchema = JSON.parse(
  readFileSync(join(here, "schemas/sarif-2.1.0-subset.schema.json"), "utf8"),
) as object;
const junitXsd = join(here, "schemas/junit-10.xsd");

const check = (id: string, title: string, severity: Finding["severity"]) =>
  defineCheck({
    id,
    area: "Visitors",
    severity,
    title,
    what: `What ${id} catches.`,
    why: `Why ${id} matters.`,
    fix: `How to fix ${id}.`,
    tech: `Technical line for ${id}.`,
    size: "S",
    done: "Gone on the next run.",
    estimateChanges: "Nothing.",
    run: () => [],
  });

const registry = new CheckRegistry()
  .register(check("menu-link-broken", "The menu link is broken", "high"))
  .register(check("title-short", "The page title is short", "medium"))
  .register(check("alt-text-missing", "A photo has no description", "low"));

const startedAt = new Date("2026-11-12T10:00:00Z");

const finding = (over: Partial<Finding> = {}): Finding => ({
  checkId: "menu-link-broken",
  severity: "high",
  title: "The menu link is broken",
  evidence: "GET https://tapas.example/menu answered 404",
  url: "https://tapas.example/menu",
  ...over,
});

const result = (
  findings: Finding[],
  over: Partial<Parameters<typeof buildResult>[0]> = {},
): Result =>
  buildResult({
    url: "https://tapas.example/",
    startedAt,
    findings,
    passed: ["canonical-link"],
    failed: [],
    ...over,
  });

const opts = { registry, version: "1.2.3" };

function validSarif(text: string): { ok: boolean; errors: string } {
  const ajv = new Ajv({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(sarifSchema);
  const ok = validate(JSON.parse(text)) as boolean;
  return { ok, errors: ok ? "" : ajv.errorsText(validate.errors) };
}

/** A small well-formedness check: tags nest and close, attributes are quoted, no stray < or &. */
function wellFormed(xml: string): string | undefined {
  if (!xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n')) return "no XML declaration";
  // eslint-disable-next-line no-control-regex -- the point is to find characters XML 1.0 forbids
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/.test(xml)) return "forbidden character";
  const body = xml.slice(xml.indexOf("\n") + 1);
  const stack: string[] = [];
  const re =
    /<(\/?)([A-Za-z][\w:-]*)((?:\s+[\w:-]+="[^"<&]*(?:&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);[^"<&]*)*")*)\s*(\/?)>|([^<]+)/g;
  let pos = 0;
  for (const m of body.matchAll(re)) {
    if (m.index !== pos) return `unparsable at ${pos}: ${body.slice(pos, pos + 40)}`;
    pos = m.index + m[0].length;
    if (m[5] !== undefined) {
      if (/&(?!(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/.test(m[5])) return "bare &";
      if (stack.length === 0 && m[5].trim() !== "") return "text outside the root";
      continue;
    }
    if (m[1]) {
      if (stack.pop() !== m[2]) return `mismatched </${m[2]}>`;
    } else if (!m[4]) stack.push(m[2] ?? "");
  }
  if (pos !== body.length) return `unparsable at ${pos}`;
  return stack.length > 0 ? `unclosed <${stack.at(-1)}>` : undefined;
}

const dir = mkdtempSync(join(tmpdir(), "gaugeline-junit-"));
afterAll(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
const xmllint = spawnSync("xmllint", ["--version"]).error === undefined;

function xsdErrors(xml: string): string {
  const file = join(dir, `out-${Math.random().toString(36).slice(2)}.xml`);
  writeFileSync(file, xml);
  const r = spawnSync("xmllint", ["--noout", "--schema", junitXsd, file], { encoding: "utf8" });
  return r.status === 0 ? "" : r.stderr;
}

describe("formatSarif", () => {
  it("validates against the SARIF 2.1.0 schema, with findings, none, and a source location", () => {
    for (const r of [
      result([]),
      result([
        finding(),
        finding({
          checkId: "title-short",
          severity: "medium",
          title: "The page title is short",
          source: { file: "src/app/page.tsx", line: 12 },
        }),
        finding({
          checkId: "alt-text-missing",
          severity: "low",
          title: "A photo has no description",
        }),
      ]),
    ]) {
      const v = validSarif(formatSarif(r, opts));
      expect(v.errors).toBe("");
      expect(v.ok).toBe(true);
    }
  });

  it("writes one rule per check id, levels from severity, and ruleIndex that points at the rule", () => {
    const sarif = JSON.parse(
      formatSarif(
        result([
          finding(),
          finding({ url: "https://tapas.example/drinks" }),
          finding({ checkId: "title-short", severity: "medium", title: "The page title is short" }),
          finding({
            checkId: "alt-text-missing",
            severity: "low",
            title: "A photo has no description",
          }),
        ]),
        opts,
      ),
    );
    const run = sarif.runs[0];
    expect(run.tool.driver.name).toBe("Gaugeline");
    expect(run.tool.driver.version).toBe("1.2.3");
    expect(run.tool.driver.rules.map((r: { id: string }) => r.id)).toEqual([
      "alt-text-missing",
      "menu-link-broken",
      "title-short",
    ]);
    expect(run.results.map((r: { level: string }) => r.level)).toEqual([
      "error",
      "error",
      "warning",
      "note",
    ]);
    for (const r of run.results) expect(run.tool.driver.rules[r.ruleIndex].id).toBe(r.ruleId);
    const rule = run.tool.driver.rules[1];
    expect(rule.help.text).toBe("How to fix menu-link-broken.");
    expect(rule.fullDescription.text).toBe("What menu-link-broken catches.");
    expect(rule.helpUri).toBe("https://gaugeline.dev/docs/checks#menu-link-broken");
    expect(rule.defaultConfiguration.level).toBe("error");
  });

  it("gives a finding with a source file and line a physical location", () => {
    const sarif = JSON.parse(
      formatSarif(
        result([finding({ source: { file: "src\\app\\menu page.tsx", line: 0 } })]),
        opts,
      ),
    );
    expect(sarif.runs[0].results[0].locations).toEqual([
      {
        physicalLocation: {
          artifactLocation: { uri: "src/app/menu%20page.tsx", uriBaseId: "%SRCROOT%" },
          region: { startLine: 1 },
        },
      },
    ]);
  });

  it("still produces valid SARIF for a finding with no file location: the page address is a logical location", () => {
    const text = formatSarif(result([finding()]), opts);
    expect(validSarif(text).errors).toBe("");
    const loc = JSON.parse(text).runs[0].results[0].locations;
    expect(loc).toEqual([
      {
        logicalLocations: [{ fullyQualifiedName: "https://tapas.example/menu", kind: "resource" }],
      },
    ]);
  });

  it("physicalLocationFallback (off by default): every page finding gets a placeholder file, still valid SARIF", () => {
    const f = [
      finding(),
      finding({ url: "https://tapas.example:8443/" }),
      finding({
        url: "https://tapas.example/a b/?x=1",
        checkId: "title-short",
        severity: "medium",
        title: "The page title is short",
      }),
      finding({ source: { file: "src/app/page.tsx", line: 4 } }),
    ];
    const off = JSON.parse(formatSarif(result(f), opts));
    expect(off.runs[0].results[0].locations[0].physicalLocation).toBeUndefined();
    const text = formatSarif(result(f), { ...opts, physicalLocationFallback: true });
    expect(validSarif(text).errors).toBe("");
    const results = JSON.parse(text).runs[0].results;
    const uri = (i: number) => results[i].locations[0].physicalLocation.artifactLocation.uri;
    expect(uri(0)).toBe("gaugeline-pages/tapas.example/menu");
    expect(uri(1)).toBe("gaugeline-pages/tapas.example/index");
    expect(uri(2)).toBe("gaugeline-pages/tapas.example/a%20b/index");
    expect(results[0].locations[0].physicalLocation.region).toEqual({ startLine: 1 });
    // A real source file is never replaced, and the address stays as a logical location.
    expect(uri(3)).toBe("src/app/page.tsx");
    expect(results[0].locations[0].logicalLocations).toHaveLength(1);
  });

  it("is the same text every time, and gives a finding the same fingerprint across runs", () => {
    const f = finding({ evidence: "GET https://tapas.example/menu answered 404 in 120 ms" });
    const a = formatSarif(result([f]), opts);
    expect(formatSarif(result([f]), opts)).toBe(a);
    const later = result([
      finding({
        evidence: "GET https://preview.tapas.example/menu answered 404 in 99 ms",
        url: "https://preview.tapas.example/menu",
      }),
    ]);
    const fp = (t: string) => JSON.parse(t).runs[0].results[0].partialFingerprints["gaugeline/v1"];
    expect(fp(formatSarif(later, opts))).toBe(fp(a));
  });

  it("carries only the finding and its evidence: capped, and with a secret redacted", () => {
    const key = ["sk", "live", "abcdefghijklmnop1234"].join("_");
    const long = `${"x".repeat(EVIDENCE_LIMIT + 200)}`;
    const text = formatSarif(
      result([finding({ evidence: `key ${key} was in the page` }), finding({ evidence: long })]),
      opts,
    );
    expect(text).not.toContain(key);
    expect(text).toContain("sk_live_[redacted]");
    const results = JSON.parse(text).runs[0].results;
    expect(results[1].properties.evidence.length).toBeLessThanOrEqual(EVIDENCE_LIMIT);
    expect(results[1].properties.evidence.endsWith("…")).toBe(true);
  });

  it("reports a check that could not run, and one the site refused, as notifications; the run is then not successful", () => {
    const sarif = JSON.parse(
      formatSarif(
        result([], {
          failed: ["links-broken"],
          couldNotCheck: [
            {
              id: "prices",
              reason: "the page answered 403",
              url: "https://tapas.example/menu?token=abc12345678",
            },
          ],
        }),
        opts,
      ),
    );
    const inv = sarif.runs[0].invocations[0];
    expect(inv.executionSuccessful).toBe(false);
    expect(inv.startTimeUtc).toBe("2026-11-12T10:00:00.000Z");
    expect(inv.toolExecutionNotifications.map((n: { level: string }) => n.level)).toEqual([
      "error",
      "warning",
    ]);
    expect(JSON.stringify(inv)).not.toContain("abc12345678");
    expect(validSarif(JSON.stringify(sarif)).errors).toBe("");
  });

  it("marks baselined and suppressed findings with SARIF suppressions, and keeps new ones unmarked", () => {
    const muted: SuppressedFinding[] = [
      { finding: finding(), kind: "baseline" },
      {
        finding: finding({
          checkId: "title-short",
          severity: "medium",
          title: "The page title is short",
        }),
        kind: "suppression",
        reason: "Rewritten after the menu launch",
        until: "2026-12-01",
      },
    ];
    const text = formatSarif(
      result([
        finding({
          checkId: "alt-text-missing",
          severity: "low",
          title: "A photo has no description",
        }),
      ]),
      { ...opts, suppressed: muted },
    );
    expect(validSarif(text).errors).toBe("");
    const results = JSON.parse(text).runs[0].results;
    expect(results).toHaveLength(3);
    const by = (id: string) => results.find((r: { ruleId: string }) => r.ruleId === id);
    expect(by("alt-text-missing").suppressions).toBeUndefined();
    expect(by("menu-link-broken").suppressions).toEqual([
      { kind: "external", status: "accepted", justification: "In the baseline" },
    ]);
    expect(by("title-short").suppressions).toEqual([
      {
        kind: "external",
        status: "accepted",
        justification: "Rewritten after the menu launch (until 2026-12-01)",
      },
    ]);
  });
});

describe("the schemas the tests use", () => {
  it("reject what SARIF and JUnit would reject", () => {
    expect(validSarif('{"version":"2.0.0","runs":[]}').ok).toBe(false);
    expect(
      validSarif(
        '{"version":"2.1.0","runs":[{"tool":{"driver":{"name":"x"}},"results":[{"message":{"text":"a"},"level":"high"}]}]}',
      ).ok,
    ).toBe(false);
    expect(
      validSarif(
        '{"version":"2.1.0","runs":[{"tool":{"driver":{"name":"x"}},"results":[{"message":{"text":"a"},"locations":[{"physicalLocation":{"region":{"startLine":0}}}]}]}]}',
      ).ok,
    ).toBe(false);
    if (xmllint)
      expect(
        xsdErrors(
          '<?xml version="1.0"?><testsuites><testsuite name="a" tests="1" errors="0"><testcase/></testsuite></testsuites>',
        ),
      ).not.toBe("");
  });
});

describe("formatJunit", () => {
  it("is well formed and passes the JUnit schema, with findings, with none, and with muted ones", () => {
    const xmls = [
      formatJunit(result([]), opts),
      formatJunit(
        result(
          [
            finding(),
            finding({
              checkId: "alt-text-missing",
              severity: "low",
              title: "A photo has no description",
            }),
          ],
          {
            failed: ["links-broken"],
            couldNotCheck: [
              { id: "prices", reason: "the page answered 403", url: "https://tapas.example/menu" },
            ],
          },
        ),
        {
          ...opts,
          suppressed: [
            { finding: finding({ url: "https://tapas.example/drinks" }), kind: "baseline" },
          ],
        },
      ),
    ];
    for (const xml of xmls) {
      expect(wellFormed(xml)).toBeUndefined();
      if (xmllint) expect(xsdErrors(xml)).toBe("");
    }
  });

  it("escapes special characters in titles, evidence and addresses", () => {
    const xml = formatJunit(
      result([
        finding({
          title: `Café "Ben & Jerry's" <menu> says 5 > 3`,
          evidence: `GET https://tapas.example/a?b=1&c=2 <script>alert("x")</script>`,
          url: "https://tapas.example/a?b=1&c=2",
        }),
      ]),
      opts,
    );
    expect(xml).toContain("&amp;");
    expect(xml).toContain("&lt;menu&gt;");
    expect(xml).toContain("&quot;");
    expect(xml).not.toContain("<script>");
    expect(xml).not.toContain("<menu>");
    expect(wellFormed(xml)).toBeUndefined();
    if (xmllint) expect(xsdErrors(xml)).toBe("");
  });

  it("drops characters XML 1.0 cannot hold", () => {
    const xml = formatJunit(
      result([
        finding({
          title: "Tab\there, bell\u0007, nul\u0000, done",
          evidence: "line one\nline two\u001b",
        }),
      ]),
      opts,
    );
    expect(wellFormed(xml)).toBeUndefined();
    expect(xml).toContain("Tab&#9;here, bell, nul, done");
  });

  it("counts: high and medium are failures, low is a pass with a note, a check that could not run is an error, a refused page is skipped", () => {
    const xml = formatJunit(
      result(
        [
          finding(),
          finding({ checkId: "title-short", severity: "medium", title: "The page title is short" }),
          finding({
            checkId: "alt-text-missing",
            severity: "low",
            title: "A photo has no description",
          }),
        ],
        {
          passed: ["canonical-link", "robots-txt"],
          failed: ["links-broken"],
          couldNotCheck: [
            { id: "prices", reason: "the page answered 403", url: "https://tapas.example/menu" },
          ],
        },
      ),
      {
        ...opts,
        suppressed: [
          { finding: finding({ url: "https://tapas.example/drinks" }), kind: "baseline" },
        ],
      },
    );
    const suite = /<testsuite [^>]*>/.exec(xml)?.[0] ?? "";
    expect(suite).toContain('tests="8"');
    expect(suite).toContain('failures="2"');
    expect(suite).toContain('errors="1"');
    expect(suite).toContain('skipped="2"');
    expect(xml).toContain('<failure message="The menu link is broken" type="high">');
    expect(xml).toContain('<skipped message="In the baseline"/>');
    expect(xml).toContain("<error ");
  });

  it("names the suite after the checked address and keeps evidence capped and redacted", () => {
    const key = ["sk", "live", "abcdefghijklmnop1234"].join("_");
    const xml = formatJunit(
      result([finding({ evidence: `${key} ${"y".repeat(EVIDENCE_LIMIT * 2)}` })]),
      opts,
    );
    expect(xml).toContain('name="https://tapas.example/"');
    expect(xml).not.toContain(key);
    expect(xml.length).toBeLessThan(EVIDENCE_LIMIT * 3);
  });

  it("is the same text every time", () => {
    const r = result([finding()]);
    expect(formatJunit(r, opts)).toBe(formatJunit(r, opts));
  });
});

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { checkAdrs, enforcedPaths } from "../lib/adr.js";

const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const adrDir = join(repoRoot, "docs/adr");
const record = (n: string, extra = "", drop?: string) =>
  [
    `# ADR-${n}: A decision`,
    "",
    "Status: accepted        Date: 2026-11-05",
    ...[
      "## Context",
      "## Decision",
      "## Alternatives",
      "## Cost",
      "## What would change it",
      "## Enforced by",
    ]
      .filter((h) => h !== drop)
      .flatMap((h) => ["", h, "", "Text."]),
    extra,
  ].join("\n");
const readmeFor = (names: string[]) => names.map((n) => `| [x](${n}) |`).join("\n");
const template = { name: "0000-template.md", text: "# ADR-NNNN: <title>\n" };

describe("check-adr: unit", () => {
  it('a record missing "## Cost" fails, naming the file and heading', () => {
    const files = [template, { name: "0001-a.md", text: record("0001", "", "## Cost") }];
    expect(checkAdrs(files, readmeFor(["0001-a.md"]))).toEqual([
      '0001-a.md: missing the heading "## Cost".',
    ]);
  });

  it("numbers 0001, 0002, 0004 fail on the gap", () => {
    const names = ["0001-a.md", "0002-b.md", "0004-d.md"];
    const files = [template, ...names.map((name) => ({ name, text: record(name.slice(0, 4)) }))];
    expect(checkAdrs(files, readmeFor(names))).toEqual([
      "ADR numbers have a gap: expected 0003, found 0004.",
    ]);
  });

  it("two files numbered 0002 fail", () => {
    const names = ["0001-a.md", "0002-b.md", "0002-c.md"];
    const files = [template, ...names.map((name) => ({ name, text: record(name.slice(0, 4)) }))];
    expect(checkAdrs(files, readmeFor(names)).join("\n")).toContain("ADR 0002 is used by 2 files");
  });

  it("a record not listed in README.md fails", () => {
    expect(checkAdrs([template, { name: "0001-a.md", text: record("0001") }], "")).toEqual([
      "0001-a.md is not listed in docs/adr/README.md.",
    ]);
  });

  it('Status "superseded by ADR-0009" where 0009 does not exist fails', () => {
    const text = record("0001").replace("Status: accepted", "Status: superseded by ADR-0009");
    expect(checkAdrs([template, { name: "0001-a.md", text }], readmeFor(["0001-a.md"]))).toEqual([
      "0001-a.md: superseded by ADR-0009, which does not exist.",
    ]);
  });
});

describe("check-adr: integration", () => {
  const files = readdirSync(adrDir)
    .filter((f) => f.endsWith(".md"))
    .map((name) => ({ name, text: readFileSync(join(adrDir, name), "utf8") }));

  it("the records and the template pass", () => {
    expect(files.map((f) => f.name).sort()).toEqual([
      "0000-template.md",
      "0001-read-only-by-construction.md",
      "0002-plain-rules-no-model-calls.md",
      "0003-no-telemetry-nothing-sent.md",
      "0004-requests-the-checked-page-names.md",
      "0005-notifications-post-to-your-own-channels.md",
      "0006-read-only-post-queries.md",
      "0008-platform-reads-through-mcp-servers-and-clis.md",
      "README.md",
    ]);
    expect(checkAdrs(files, files.find((f) => f.name === "README.md")?.text ?? "")).toEqual([]);
  });

  it('every "Enforced by" entry names a file path that exists in the repository', () => {
    for (const f of files.filter((x) => /^000[1-9]/.test(x.name))) {
      const paths = enforcedPaths(f.text);
      expect(paths.length, f.name).toBeGreaterThan(0);
      for (const p of paths) expect(existsSync(join(repoRoot, p)), `${f.name}: ${p}`).toBe(true);
    }
  });
});

describe("check-adr: edge cases", () => {
  it("the template 0000 is exempt from the heading rule and from the README index", () => {
    expect(checkAdrs([{ name: "0000-template.md", text: "anything" }], "")).toEqual([]);
  });

  it("a record with Windows line endings passes", () => {
    const text = record("0001").replace(/\n/g, "\r\n");
    expect(checkAdrs([template, { name: "0001-a.md", text }], readmeFor(["0001-a.md"]))).toEqual(
      [],
    );
  });
});

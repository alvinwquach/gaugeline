/**
 * The check writer (AG-16): a draft from an advisory or a docs page, every claim cited, refused when a floor
 * has no cited line or a cited line leaks, with a failing and a passing fixture that the existing version
 * reader agrees with, and nothing edited.
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { installedVersions } from "../../checks/static/installed-version.js";
import { treeOf } from "../../checks/static/__tests__/helpers.js";
import { compileDenyList } from "../../field-findings/scrub.js";
import { PACKAGE_ADVISORIES, inRange, type Advisory } from "../../libraries/advisories.js";
import {
  ADVISORY_GITHUB_JSON,
  ADVISORY_MARKDOWN,
  ADVISORY_OSV_JSON,
  CHECK_WRITER_DENY_LIST,
  CLIENT_NAME_MARKDOWN,
  CONTACT_MARKDOWN,
  DOCS_MARKDOWN,
  HOSTILE_MARKDOWN,
  MALFORMED_JSON,
  PARTLY_MARKDOWN,
  PRIVATE_URL_MARKDOWN,
  UNKNOWN_MARKDOWN,
} from "../example.js";
import {
  buildCheckWriterDraft,
  checkWriterDraftSchema,
  fixtureVersions,
  scanCheckWriterDraft,
  scrubCheckWriterDraft,
  writeCheckDraft,
  type CheckWriterDraft,
} from "../draft.js";
import { AdvisoryInputError, readAdvisory, type AdvisoryFile } from "../input.js";

const write = (f: AdvisoryFile, registry: Record<string, readonly Advisory[]> = {}) =>
  writeCheckDraft(f, { denyList: CHECK_WRITER_DENY_LIST, registry });
const draftOf = (
  f: AdvisoryFile,
  registry: Record<string, readonly Advisory[]> = {},
): CheckWriterDraft => {
  const r = write(f, registry);
  if (!r.ok) throw new Error("expected a draft");
  return r.draft;
};
const file = (name: string, text: string): AdvisoryFile => ({ name, text });

describe("a draft from each shape", () => {
  it.each([
    [ADVISORY_MARKDOWN, "advisory-markdown", [["kiln-forms", "2.0.0", "2.4.3"]]],
    [
      ADVISORY_OSV_JSON,
      "osv-json",
      [
        ["pixel-gallery", "1.0.0", "1.8.2"],
        ["pixel-gallery", "2.0.0", "2.1.1"],
      ],
    ],
    [ADVISORY_GITHUB_JSON, "github-json", [["menu-embed", null, "3.2.0"]]],
    [DOCS_MARKDOWN, "docs-markdown", [["booking-calendar", null, "5.1.0"]]],
  ] as const)("%#", (f, shape, expected) => {
    const d = draftOf(f);
    expect(d.shape).toBe(shape);
    expect(
      d.floors.map((x) => [x.package.value, x.introduced?.value ?? null, x.fixed.value]),
    ).toEqual(expected);
    expect(checkWriterDraftSchema.safeParse(d).success).toBe(true);
    expect(d.scrub).toEqual({ ok: true, claimsChecked: expect.any(Number) });
  });

  it("every claim holds its value on its cited line, and the line is in the file", () => {
    for (const f of [ADVISORY_MARKDOWN, ADVISORY_OSV_JSON, ADVISORY_GITHUB_JSON, DOCS_MARKDOWN]) {
      const d = draftOf(f);
      expect(
        scrubCheckWriterDraft(d, {
          fileText: f.text,
          deny: compileDenyList(CHECK_WRITER_DENY_LIST),
        }),
      ).toEqual([]);
    }
  });

  it("the same file gives the same draft and the same Markdown, twice", () => {
    for (const f of [ADVISORY_MARKDOWN, ADVISORY_OSV_JSON, DOCS_MARKDOWN]) {
      const a = write(f);
      const b = write(file(f.name, f.text));
      expect(a).toEqual(b);
    }
  });

  it("a Windows line ending changes nothing", () => {
    const crlf = file("a.md", ADVISORY_MARKDOWN.text.replace(/\n/g, "\r\n"));
    expect(draftOf(crlf)).toEqual(draftOf(ADVISORY_MARKDOWN));
  });

  it("a docs page has no id, and says so", () => {
    const r = write(DOCS_MARKDOWN);
    expect(r.ok && r.draft.advisoryId).toBeNull();
    expect(r.ok && r.markdown).toContain("has no CVE or GHSA id");
  });

  it("a hostile file: the orders are ignored and counted, never copied, and the rest is drafted", () => {
    const r = write(HOSTILE_MARKDOWN);
    expect(r.ok && r.draft.notProposed.instructionLines).toBe(2);
    expect(r.ok && JSON.stringify(r)).not.toMatch(
      /publish_check|publish a new check|edits the registry/i,
    );
    expect(r.ok && r.markdown).toContain(
      "2 lines that gave an order to an assistant, ignored and never copied",
    );
  });

  it("a file read in part drafts what it understood and lists the rest by line", () => {
    const r = write(PARTLY_MARKDOWN);
    expect(r.ok && r.draft.floors.map((f) => f.package.value)).toEqual(["kiln-forms"]);
    expect(r.ok && r.draft.notUnderstood).toEqual([
      { line: 9, reason: "unsupported-ecosystem" },
      { line: 10, reason: "range-without-fix" },
    ]);
    expect(r.ok && r.markdown).toContain(
      "Line 9: a package outside npm, or with no ecosystem given.",
    );
  });
});

describe("refused: the scrub fails the draft and nothing is written", () => {
  it.each([
    [CLIENT_NAME_MARKDOWN, "name", "source.title", 1],
    [PRIVATE_URL_MARKDOWN, "private-url", "source.url", 4],
  ] as const)("%#", (f, kind, path, line) => {
    const r = write(f);
    expect(r).toMatchObject({ ok: false, reason: "refused" });
    expect(r.ok === false && r.reason === "refused" && r.problems).toEqual([{ kind, path, line }]);
    expect("draft" in r).toBe(false);
  });

  it("an email and a phone number are named by kind and line, never shown", () => {
    const r = write(CONTACT_MARKDOWN);
    expect(r.ok === false && r.reason === "refused" && r.problems.map((p) => p.kind)).toEqual([
      "email",
      "phone",
    ]);
    expect(JSON.stringify(r)).not.toMatch(/kitchen|7946/);
  });

  it("a client name in a cited line of a floor is refused too", () => {
    const f = file(
      "a.md",
      ADVISORY_MARKDOWN.text.replace(/\| 2\.4\.3 +\|/, "| 2.4.3 Northgate Studio |"),
    );
    // The patched cell is no longer a version: listed, not drafted, and nothing leaks.
    const r = write(f);
    expect(r).toMatchObject({ ok: false, reason: "not-understood" });
    expect(JSON.stringify(r)).not.toMatch(/Northgate/);
  });

  it("a deny-list name that is only in a line the writer never uses does not refuse the draft", () => {
    const f = file("a.md", `${ADVISORY_MARKDOWN.text}\nThe Tidewater Bar site was affected.\n`);
    expect(write(f)).toMatchObject({ ok: true });
  });

  it("a file with no deny-list still refuses a private address, an email and a phone number", () => {
    const r = writeCheckDraft(PRIVATE_URL_MARKDOWN, { registry: {} });
    expect(r).toMatchObject({ ok: false, reason: "refused" });
  });

  it("a deny-list that cannot be used stops the run, naming a line and never the name", () => {
    expect(() => writeCheckDraft(ADVISORY_MARKDOWN, { denyList: "ab\n" })).toThrow(/line 1/);
  });
});

describe("a floor with no cited line fails the scrub", () => {
  const good = () => draftOf(ADVISORY_MARKDOWN);
  const without = (d: CheckWriterDraft): CheckWriterDraft => ({
    ...d,
    floors: d.floors.map((f) => ({
      ...f,
      fixed: { ...f.fixed, cite: { ...f.fixed.cite, text: "" } },
    })),
  });

  it("an empty cited line: the schema refuses it, and the scrub names the claim", () => {
    const bad = without(good());
    expect(checkWriterDraftSchema.safeParse(bad).success).toBe(false);
    expect(scrubCheckWriterDraft(bad)).toEqual([
      { kind: "no-cite", path: "floors.0.fixed", line: 9 },
    ]);
  });

  it("a cited line that does not hold the version", () => {
    const d = good();
    const bad = {
      ...d,
      floors: d.floors.map((f) => ({ ...f, fixed: { ...f.fixed, value: "2.4.9" } })),
    };
    expect(scrubCheckWriterDraft(bad).map((p) => p.kind)).toEqual(["cite-mismatch"]);
    expect(checkWriterDraftSchema.safeParse(bad).success).toBe(false);
  });

  it("a cited line that is not in the file: an invented line", () => {
    const d = good();
    const line = "| kiln-forms (npm) | >= 2.0.0, < 2.4.9 | 2.4.9 |";
    const bad: CheckWriterDraft = {
      ...d,
      floors: d.floors.map((f) => ({
        ...f,
        introduced: f.introduced && { ...f.introduced, cite: { line: 9, text: line } },
        fixed: { value: "2.4.9", cite: { line: 9, text: line } },
        fixture: { failing: "2.4.8", passing: "2.4.9" },
      })),
    };
    expect(checkWriterDraftSchema.safeParse(bad).success).toBe(true);
    expect(scrubCheckWriterDraft(bad).map((p) => p.kind)).toEqual([]);
    expect(
      scrubCheckWriterDraft(bad, { fileText: ADVISORY_MARKDOWN.text }).map((p) => p.kind),
    ).toEqual(["cite-not-in-file", "cite-not-in-file"]);
  });

  it("the scan the eval harness runs gives path and kind, no text", () => {
    expect(scanCheckWriterDraft(without(good()))).toEqual(["floors.0.fixed: no-cite"]);
  });

  it("a draft with no floor, or a floor with a fixture that does not match it, is not a draft", () => {
    const d = good();
    expect(checkWriterDraftSchema.safeParse({ ...d, floors: [] }).success).toBe(false);
    const bad = {
      ...d,
      floors: d.floors.map((f) => ({ ...f, fixture: { failing: "9.9.9", passing: "2.4.3" } })),
    };
    expect(checkWriterDraftSchema.safeParse(bad).success).toBe(false);
  });
});

describe("not understood: no draft", () => {
  it("a page in no shape the writer reads", () => {
    expect(write(UNKNOWN_MARKDOWN)).toEqual({
      ok: false,
      reason: "not-understood",
      notUnderstood: [{ line: null, reason: "unknown-shape" }],
      notUnderstoodCount: 1,
      instructionLines: 0,
    });
    const j = write(file("a.json", '{"hello": "world"}'));
    expect(j).toMatchObject({ ok: false, reason: "not-understood", notUnderstoodCount: 1 });
  });

  it("a file that cannot be read at all throws, with fixed words", () => {
    expect(() => write(MALFORMED_JSON)).toThrow(AdvisoryInputError);
  });
});

describe("the registry: proposed beside what it holds, never changed", () => {
  const entry = (id: string, fixed: string, introduced?: string): Advisory => ({
    id,
    summary: "x",
    affects: [{ ...(introduced ? { introduced } : {}), fixed }],
    source: "https://advisories.example.org/x",
    verified: true,
  });
  const state = (f: AdvisoryFile, reg: Record<string, readonly Advisory[]>) =>
    draftOf(f, reg).floors[0]!.registry;

  it("a package the registry does not list", () => {
    expect(state(ADVISORY_MARKDOWN, {})).toBe("new-package");
    expect(state(ADVISORY_MARKDOWN, { "kiln-forms": [] })).toBe("new-package");
  });
  it("the same advisory, listed the same, or listed with another range, or not listed", () => {
    expect(
      state(ADVISORY_MARKDOWN, { "kiln-forms": [entry("GHSA-m4h7-9p2x-c8hq", "2.4.3", "2.0.0")] }),
    ).toBe("already-listed");
    expect(
      state(ADVISORY_MARKDOWN, { "kiln-forms": [entry("GHSA-m4h7-9p2x-c8hq", "2.4.1", "2.0.0")] }),
    ).toBe("range-differs");
    expect(
      state(ADVISORY_MARKDOWN, { "kiln-forms": [entry("GHSA-other-0000-0000", "2.4.3")] }),
    ).toBe("new-advisory");
  });
  it("a docs page floor against the highest fixed version the registry lists", () => {
    expect(
      state(DOCS_MARKDOWN, { "booking-calendar": [entry("GHSA-aaaa-0000-0000", "5.0.0")] }),
    ).toBe("raises-floor");
    expect(
      state(DOCS_MARKDOWN, { "booking-calendar": [entry("GHSA-aaaa-0000-0000", "5.1.0")] }),
    ).toBe("same-floor");
    expect(
      state(DOCS_MARKDOWN, { "booking-calendar": [entry("GHSA-aaaa-0000-0000", "5.3.0")] }),
    ).toBe("below-floor");
  });
  it("a package named like an object method is an ordinary package", () => {
    const f = file("a.md", ADVISORY_MARKDOWN.text.replace(/kiln-forms/g, "constructor"));
    expect(state(f, {})).toBe("new-package");
  });

  it("the real registry is only read: writing a draft changes nothing in it", () => {
    const before = JSON.stringify(PACKAGE_ADVISORIES);
    const r = writeCheckDraft(ADVISORY_OSV_JSON, { denyList: CHECK_WRITER_DENY_LIST });
    expect(r.ok && r.draft.floors[0]?.registry).toBe("new-package");
    expect(JSON.stringify(PACKAGE_ADVISORIES)).toBe(before);
    expect(Object.isFrozen(PACKAGE_ADVISORIES)).toBe(true);
  });

  it("a draft for a package the registry lists compares with the real list", () => {
    const f = file("a.md", ADVISORY_MARKDOWN.text.replace(/kiln-forms/g, "zod"));
    const r = writeCheckDraft(f, {});
    expect(r.ok && r.draft.floors[0]?.registry).toBe("new-advisory");
  });
});

describe("the fixtures are real: the version reader and the range agree with them", () => {
  it.each([
    ["2.0.0", "2.4.3", "2.4.2"],
    ["1.0.0", "1.8.2", "1.8.1"],
    [undefined, "5.1.0", "5.0.0"],
    [undefined, "3.0.0", "2.0.0"],
    ["1.0.0", "2.0.0", "1.0.0"],
    ["2.0.0", "2.1.0", "2.0.0"],
    [undefined, "4.1", "4.0.0"],
  ])("introduced %s, fixed %s: failing %s", (introduced, fixed, failing) => {
    const v = fixtureVersions(introduced, fixed);
    expect(v?.failing).toBe(failing);
    expect(v?.passing).toBe(fixed.split(".").concat(["0"]).slice(0, 3).join("."));
    expect(inRange(v!.failing, { ...(introduced ? { introduced } : {}), fixed })).toBe(true);
  });

  it("no fixture for a pre-release floor, or a range no version can sit in", () => {
    expect(fixtureVersions(undefined, "2.0.0-beta.1")).toBeNull();
    expect(fixtureVersions("0.0.1", "0.0.1")).toBeNull();
  });

  it.each([ADVISORY_MARKDOWN, ADVISORY_OSV_JSON, ADVISORY_GITHUB_JSON, DOCS_MARKDOWN])(
    "$name: the failing lockfile installs a version in the range, the passing one the floor",
    (f) => {
      const d = draftOf(f);
      for (const floor of d.floors) {
        const pkg = floor.package.value;
        const fx = floor.fixture!;
        const range = {
          ...(floor.introduced ? { introduced: floor.introduced.value } : {}),
          fixed: floor.fixed.value,
        };
        const lock = (v: string) =>
          JSON.stringify({
            lockfileVersion: 3,
            packages: { "": {}, [`node_modules/${pkg}`]: { version: v } },
          });
        const manifest = (v: string) => JSON.stringify({ dependencies: { [pkg]: `^${v}` } });
        const read = (v: string) =>
          installedVersions(
            {
              kind: "local-source",
              tree: treeOf({ "package.json": manifest(v), "package-lock.json": lock(v) }),
            },
            pkg,
          );
        const failing = read(fx.failing)[0];
        const passing = read(fx.passing)[0];
        expect(failing).toMatchObject({ state: "version", version: fx.failing });
        expect(passing).toMatchObject({ state: "version", version: fx.passing });
        expect(inRange(fx.failing, range)).toBe(true);
        expect(inRange(fx.passing, range)).toBe(false);
      }
    },
  );

  it("the Markdown carries both fixtures as the lockfile text a person copies", () => {
    const r = write(ADVISORY_MARKDOWN);
    const md = r.ok ? r.markdown : "";
    expect(md).toContain("### Failing fixture: kiln-forms 2.4.2 (in the affected range)");
    expect(md).toContain("### Passing fixture: kiln-forms 2.4.3 (the floor)");
    expect(md.match(/"node_modules\/kiln-forms": \{\n\s+"version": "2\.4\.[23]"/g)).toHaveLength(2);
  });
});

describe("the Markdown is a draft, with the registry entry as text", () => {
  const md = (f: AdvisoryFile) => {
    const r = write(f);
    if (!r.ok) throw new Error("expected a draft");
    return r.markdown;
  };

  it("says it is a draft, that nothing was applied, and that every claim is cited", () => {
    const m = md(ADVISORY_MARKDOWN);
    expect(m).toMatch(/^# Check draft \(DRAFT\)/);
    expect(m).toContain("Nothing here is applied");
    expect(m).toContain("a claim with no cited line is refused");
    expect(m).toContain(
      "- Fixed in (the floor): `2.4.3`. Line 9: `| kiln-forms (npm) | >= 2.0.0, < 2.4.3 | 2.4.3            |`",
    );
    expect(m).toContain(
      "- Address, as given in the file: `https://advisories.example.org/GHSA-m4h7-9p2x-c8hq` (line 5)",
    );
  });

  it("the registry entry is unverified, and a person has to adopt it", () => {
    const m = md(ADVISORY_MARKDOWN);
    const json = /```json\n(\{\n {2}"package": "kiln-forms"[\s\S]*?\n\})\n```/.exec(m)?.[1];
    expect(JSON.parse(json!)).toEqual({
      package: "kiln-forms",
      advisory: {
        id: "GHSA-m4h7-9p2x-c8hq",
        summary: "kiln-forms: denial of service when parsing nested form fields",
        affects: [{ introduced: "2.0.0", fixed: "2.4.3" }],
        source: "https://advisories.example.org/GHSA-m4h7-9p2x-c8hq",
        verified: false,
      },
    });
    expect(m).toContain(
      "`verified` stays false until a person has compared the entry with its page",
    );
  });

  it("a long title is not cut into a summary: a person is asked to write one", () => {
    const title = `kiln-forms: ${"a very long title ".repeat(8)}`.trim();
    const f = file("a.md", ADVISORY_MARKDOWN.text.replace(/^# .*$/m, `# ${title}`));
    expect(md(f)).toContain("TODO: shorten the page title to under 80 characters");
  });

  it("the check outline claims only what the file stated, and leaves the why to a person", () => {
    const m = md(ADVISORY_MARKDOWN);
    expect(m).toContain("- Id: `kiln-forms-version-advisory`");
    expect(m).toContain("is below 2.4.3, the version that fixes `GHSA-m4h7-9p2x-c8hq`");
    expect(m).toContain("- Why: a person writes this.");
    expect(md(DOCS_MARKDOWN)).toContain("the minimum the page states");
  });

  it("a title with Markdown in it is escaped, and a backtick cannot close a code span or a fence", () => {
    const title = "kiln-forms: [click](https://x.example.org) `x` ``` # heading";
    const f = file("a.md", ADVISORY_MARKDOWN.text.replace(/^# .*$/m, `# ${title}`));
    const m = md(f);
    // Outside a code block or span the title is escaped, so it is not a link.
    const prose = m.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
    expect(prose).not.toContain("[click](https://x.example.org)");
    expect(prose).toContain("\\[click\\]");
    expect(m.split("\n").filter((l) => l.startsWith("```"))).toSatisfy(
      (fences: string[]) => fences.length % 2 === 0,
    );
    expect(JSON.stringify(m)).not.toContain("\\u0060\\u0060");
  });

  it("holds no file name and no text of a line it did not use", () => {
    const m = md(HOSTILE_MARKDOWN);
    expect(m).not.toContain(HOSTILE_MARKDOWN.name);
    expect(m).not.toMatch(/ignore (all )?previous|publish_check|assistant that edits/i);
  });
});

describe("built from the readers' own code: no request, no file, no model", () => {
  const dir = fileURLToPath(new URL("..", import.meta.url));
  const sources = readdirSync(dir)
    .filter((n) => n.endsWith(".ts"))
    .map((n) => [n, readFileSync(`${dir}/${n}`, "utf8")] as const);

  it.each(sources)("%s imports no filesystem, network, process or model module", (_n, text) => {
    expect(text).not.toMatch(
      /from\s+["']node:(?:fs|http|https|net|child_process|worker_threads|dns|tls|dgram)/,
    );
    expect(text).not.toMatch(
      /\bfetch\s*\(|\bXMLHttpRequest\b|\beval\s*\(|new Function\s*\(|\bprocess\.exit\b/,
    );
    expect(text).not.toMatch(/from\s+["'](?:openai|@anthropic-ai|ai|@ai-sdk)/);
  });

  it("buildCheckWriterDraft needs a title, an address and a floor", () => {
    expect(() => buildCheckWriterDraft(readAdvisory(UNKNOWN_MARKDOWN))).toThrow(
      /no title, address or floor/,
    );
  });
});

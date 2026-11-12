/**
 * The fixed shapes of the draft kinds (G37, ADR-0010 parts 1 and 8). No database needed: these run on the
 * whole CI matrix. The same payloads are given to the database's own validator in inbox.test.ts, which
 * must agree with every verdict here.
 */
import { describe, expect, it } from "vitest";
import {
  checkDraftPayload,
  isSafeRepoPath,
  jsonbText,
  MAX_PAYLOAD_BYTES,
} from "../../inbox/kinds.js";

/** Characters that break a line, built from code points so the source holds no invisible character. */
const BREAKS = [0x85, 0x80, 0x9f, 0x2028, 0x2029, 0x0b, 0x0c, 0x0d, 0x7f].map((c) =>
  String.fromCharCode(c),
);

const pr = (over: Record<string, unknown> = {}) => ({
  title: "Point the menu link at /drinks",
  body: "The menu page links to /drinks-2025, which returns 404.",
  files: [{ path: "app/menu/links.ts", content: "export const drinks = '/drinks';\n" }],
  ...over,
});
const sanity = (set: Record<string, unknown>) => ({
  documentId: "menu",
  documentType: "page",
  set,
});
const ok = (kind: string, payload: unknown) => checkDraftPayload(kind, payload).ok;

describe("sanity_draft fields", () => {
  it("refuses Sanity's own system fields (anything starting with an underscore)", () => {
    for (const key of ["_id", "_type", "_rev", "_createdAt", "_key", "__x"])
      expect(ok("sanity_draft", sanity({ [key]: "menu", title: "x" })), key).toBe(false);
    expect(
      ok("sanity_draft", sanity({ title: "Opening hours", rating: 4.5, open: true, note: null })),
    ).toBe(true);
  });

  it("refuses a number whose JSON and jsonb text differ (exponent notation)", () => {
    for (const n of [1e21, 1e-7, Infinity, NaN])
      expect(ok("sanity_draft", sanity({ n })), String(n)).toBe(false);
    expect(ok("sanity_draft", sanity({ n: 0 }))).toBe(true);
    expect(ok("sanity_draft", sanity({ n: 123456.789 }))).toBe(true);
  });

  it("refuses a number with more than 15 significant digits: the writer would write another value", () => {
    // 0.1 + 0.2 prints as 0.30000000000000004 and a long decimal rounds when parsed; the approved text and
    // the value the writer parses must be the same, so a double that needs 16 or 17 digits is refused.
    for (const n of [0.1 + 0.2, 1 / 3, Number("0.1234567890123456789012345"), 100000000000000.5])
      expect(ok("sanity_draft", sanity({ n })), String(n)).toBe(false);
    for (const n of [0.1, 4.5, -0.25, 999999999999999, 0.000001, 123456789012.345])
      expect(ok("sanity_draft", sanity({ n })), String(n)).toBe(true);
  });
});

describe("single-line fields", () => {
  it("refuse every line-breaking and control character, in a title and a subject", () => {
    for (const ch of BREAKS) {
      expect(ok("pull_request", pr({ title: `a${ch}b` })), `title U+${ch.charCodeAt(0)}`).toBe(
        false,
      );
      expect(ok("email", { subject: `a${ch}b`, body: "x" }), `subject`).toBe(false);
    }
    expect(ok("email", { subject: "a\tb", body: "x" })).toBe(true);
  });

  it("refuse bidirectional controls and the non-characters U+FFFE and U+FFFF", () => {
    const tricks = [
      ...[0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069],
      0xfffe,
      0xffff,
    ].map((c) => String.fromCharCode(c));
    for (const ch of tricks) {
      const label = `U+${ch.charCodeAt(0).toString(16)}`;
      expect(ok("pull_request", pr({ title: `a${ch}b` })), `title ${label}`).toBe(false);
      expect(ok("email", { subject: `a${ch}b`, body: "x" }), `subject ${label}`).toBe(false);
    }
    // Neighbours of the ranges, and right-to-left text itself, are fine.
    for (const c of [0x202f, 0x2065, 0x206a, 0xfffd, 0x05d0])
      expect(ok("email", { subject: `a${String.fromCharCode(c)}b`, body: "x" }), String(c)).toBe(
        true,
      );
  });

  it("prose keeps its newlines but not C1 controls or the Unicode separators", () => {
    expect(ok("email", { subject: "s", body: "line one\nline two\tindented" })).toBe(true);
    for (const ch of ["\u0085", "\u0080", "\u009f", "\u2028", "\u2029", "\r", "\u000b"])
      expect(ok("email", { subject: "s", body: `a${ch}b` }), `U+${ch.charCodeAt(0)}`).toBe(false);
  });
});

describe("repository paths", () => {
  const refused = [
    ".git/config",
    "sub/.git/hooks/pre-commit",
    "a/b/.GIT/x",
    ".git./config",
    ".gitmodules",
    "docs/.gitmodules",
    ".github/workflows/x.yml",
    "packages/app/.github/workflows/x.yml",
    ".circleci/config.yml",
    "x/.circleci/config.yml",
    ".gitlab-ci.yml",
    "x/.gitlab-ci.yml",
    ".husky/pre-commit",
    "x/.husky/pre-commit",
    "../x",
    "a/../x",
    "a/./x",
    "...",
    "a/.../x",
    "/etc/passwd",
    "-rf",
    "a/-b",
    "a//b",
    "a/",
    "",
    "a b",
    "a\\b",
    "x".repeat(301),
  ];
  const allowed = [
    "app/menu/links.ts",
    "src/[id]/(group)/@modal/page.tsx",
    ".eslintrc.json",
    "docs/.env.example",
    "a.git/x",
    "github/x",
    "gitmodules",
    ".githubx/y",
  ];
  it("refuses sensitive and traversing paths at any depth", () => {
    for (const p of refused) expect(isSafeRepoPath(p), JSON.stringify(p)).toBe(false);
  });
  it("allows ordinary ones", () => {
    for (const p of allowed) expect(isSafeRepoPath(p), p).toBe(true);
  });
  it("refuses two paths in one pull request that differ only by case", () => {
    const two = (a: string, b: string) =>
      pr({
        files: [
          { path: a, content: "x" },
          { path: b, content: "y" },
        ],
      });
    expect(ok("pull_request", two("docs/Readme.md", "docs/README.md"))).toBe(false);
    expect(ok("pull_request", two("a/b.txt", "A/b.txt"))).toBe(false);
    expect(ok("pull_request", two("docs/readme.md", "docs/readme.md"))).toBe(false);
    expect(ok("pull_request", two("docs/readme.md", "docs/readme2.md"))).toBe(true);
  });
  it("applies in a pull request payload", () => {
    for (const path of refused.slice(0, 15))
      expect(ok("pull_request", pr({ files: [{ path, content: "x" }] })), path).toBe(false);
  });
});

describe("size and storable characters (the database's limits, checked before it is asked)", () => {
  it("measures the jsonb text, which has a space after each colon and comma", () => {
    expect(jsonbText({ a: 1, b: [1, "x"], c: { d: null } })).toBe(
      '{"a": 1, "b": [1, "x"], "c": {"d": null}}',
    );
  });

  it("an edit over 16 KB is a problem, not an error", () => {
    const r = checkDraftPayload("pull_request", pr({ body: "x".repeat(17_000) }));
    expect(r).toMatchObject({ ok: false });
    expect(r.ok ? [] : r.problems.join()).toMatch(/at most 16384 are kept/);
  });

  it("the cap is on the jsonb text: many short fields can pass JSON.stringify and still not fit", () => {
    // 20 files of ~790 bytes in JSON, a few bytes more as jsonb text.
    const files = Array.from({ length: 20 }, (_, i) => ({
      path: `f${i}.txt`,
      content: "x".repeat(780),
    }));
    const p = pr({ files, body: "" });
    const json = Buffer.byteLength(JSON.stringify(p));
    const jsonb = Buffer.byteLength(jsonbText(p));
    expect(json).toBeLessThanOrEqual(MAX_PAYLOAD_BYTES);
    expect(jsonb).toBeGreaterThan(json);
    // Grow the content until the two texts straddle the cap.
    const pad = MAX_PAYLOAD_BYTES - json;
    const straddle = pr({
      files: [{ ...files[0]!, content: "x".repeat(780 + pad) }, ...files.slice(1)],
      body: "",
    });
    expect(Buffer.byteLength(JSON.stringify(straddle))).toBe(MAX_PAYLOAD_BYTES);
    expect(ok("pull_request", straddle)).toBe(false);
  });

  it("a payload exactly at the cap is accepted", () => {
    const base = pr({ body: "" });
    const room = MAX_PAYLOAD_BYTES - Buffer.byteLength(jsonbText(base));
    const full = pr({ body: "x".repeat(room) });
    expect(Buffer.byteLength(jsonbText(full))).toBe(MAX_PAYLOAD_BYTES);
    expect(ok("pull_request", full)).toBe(true);
    expect(ok("pull_request", pr({ body: "x".repeat(room + 1) }))).toBe(false);
  });

  it("U+0000 and an unpaired surrogate are problems, in a value or a key", () => {
    for (const bad of ["a\u0000b", "a\ud800b", "\udc00"]) {
      expect(ok("pull_request", pr({ files: [{ path: "a.txt", content: bad }] }))).toBe(false);
      expect(ok("email", { subject: "s", body: bad })).toBe(false);
      expect(ok("sanity_draft", sanity({ title: bad }))).toBe(false);
      expect(ok("email", { subject: "s", body: "b", [bad]: 1 })).toBe(false);
    }
    expect(
      ok("pull_request", pr({ files: [{ path: "a.txt", content: "caf\u00E9 \u{1F378}" }] })),
    ).toBe(true);
  });

  it("deep nesting does not overflow the stack", () => {
    let deep: unknown = "x";
    for (let i = 0; i < 100_000; i++) deep = [deep];
    expect(ok("email", deep)).toBe(false);
  });
});

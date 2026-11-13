/**
 * The writer's kinds.ts is a copy of the inbox's (apps/hosted/inbox/kinds.ts, mirrored in the database)
 * with a longer list of paths the writer never writes. What was approved in the inbox must be something
 * the writer can read, and the writer must never accept what the inbox would have refused: so on every
 * payload below the two agree, except for the paths on the writer's own list.
 */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { checkDraftPayload as inbox } from "../../../../apps/hosted/inbox/kinds.js";
import { checkDraftPayload as writer, isSafeRepoPath } from "../kinds.js";

const pr = (over: Record<string, unknown> = {}) => ({
  title: "Point the menu link at /drinks",
  body: "The menu page links to /drinks-2025.",
  files: [{ path: "content/menu.md", content: "x" }],
  ...over,
});
const file = (path: string) => pr({ files: [{ path, content: "x" }] });

const SAME: [string, string, unknown][] = [
  ["pull_request", "a plain draft", pr()],
  ["pull_request", "an unknown key", pr({ branch: "main" })],
  ["pull_request", "a title with a line break", pr({ title: "a\nb" })],
  ["pull_request", "a title with a bidirectional control", pr({ title: "a\u202Eb" })],
  ["pull_request", "a title with a C1 control", pr({ title: "a\u0085b" })],
  ["pull_request", "a body with a line separator", pr({ body: "a\u2028b" })],
  ["pull_request", "a body with a NUL", pr({ body: "a\u0000b" })],
  ["pull_request", "a lone surrogate", pr({ body: "a\ud800b" })],
  ["pull_request", "no files", pr({ files: [] })],
  [
    "pull_request",
    "21 files",
    pr({ files: Array.from({ length: 21 }, (_, i) => ({ path: `c/${i}.md`, content: "" })) }),
  ],
  [
    "pull_request",
    "a path twice",
    pr({
      files: [
        { path: "c/a.md", content: "1" },
        { path: "c/a.md", content: "2" },
      ],
    }),
  ],
  [
    "pull_request",
    "a path twice, case aside",
    pr({
      files: [
        { path: "c/a.md", content: "1" },
        { path: "c/A.md", content: "2" },
      ],
    }),
  ],
  ["pull_request", "a climbing path", file("../x")],
  ["pull_request", "a dot-only segment", file("a/.../b")],
  ["pull_request", "an absolute path", file("/x")],
  ["pull_request", "a leading dash", file("-x")],
  ["pull_request", "a workflow", file(".github/workflows/x.yml")],
  ["pull_request", "the git folder, in capitals with a trailing dot", file("a/.GIT./config")],
  [
    "pull_request",
    "a payload over the byte limit",
    pr({ body: "x".repeat(20_000), files: [{ path: "a.md", content: "y".repeat(2000) }] }),
  ],
  ["pull_request", "a title with U+FFFE", pr({ title: "a\uFFFEb" })],
  ["pull_request", "a title with U+FFFF", pr({ title: "a\uFFFFb" })],
  ["pull_request", "a body with U+FFFF (allowed in prose)", pr({ body: "a\uFFFFb" })],
  ["pull_request", "a title with a bidirectional isolate", pr({ title: "a\u2066b" })],
  ["pull_request", "a title with a tab", pr({ title: "a\tb" })],
  ["pull_request", "a path with a trailing dot on a folder", file("content./menu.md")],
  [
    "pull_request",
    "three paths, two the same but for case",
    pr({
      files: [
        { path: "c/a.md", content: "" },
        { path: "c/b.md", content: "" },
        { path: "C/B.md", content: "" },
      ],
    }),
  ],
  [
    "sanity_draft",
    "15 significant digits",
    { documentId: "menu", documentType: "page", set: { n: 123456789012345 } },
  ],
  [
    "sanity_draft",
    "16 significant digits",
    { documentId: "menu", documentType: "page", set: { n: 1234567890123456 } },
  ],
  ["sanity_draft", "1e-7", { documentId: "menu", documentType: "page", set: { n: 1e-7 } }],
  ["sanity_draft", "1e-6", { documentId: "menu", documentType: "page", set: { n: 1e-6 } }],
  [
    "sanity_draft",
    "a long field name",
    { documentId: "menu", documentType: "page", set: { ["a".repeat(65)]: 1 } },
  ],
  [
    "sanity_draft",
    "21 fields",
    {
      documentId: "menu",
      documentType: "page",
      set: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`f${i}`, i])),
    },
  ],
  ["email", "a draft", { subject: "Hello", body: "Hi" }],
  ["email", "a recipient", { subject: "Hello", body: "Hi", to: "x" }],
  [
    "sanity_draft",
    "a draft",
    { documentId: "menu", documentType: "page", set: { title: "Drinks", count: 3 } },
  ],
  [
    "sanity_draft",
    "an underscore field",
    { documentId: "menu", documentType: "page", set: { _id: "x" } },
  ],
  [
    "sanity_draft",
    "0.1 + 0.2",
    { documentId: "menu", documentType: "page", set: { n: 0.1 + 0.2 } },
  ],
  ["sanity_draft", "a huge number", { documentId: "menu", documentType: "page", set: { n: 1e21 } }],
  ["sanity_draft", "no fields", { documentId: "menu", documentType: "page", set: {} }],
  [
    "sanity_draft",
    "a drafts. id",
    { documentId: "drafts.menu", documentType: "page", set: { a: 1 } },
  ],
  ["unknown_kind", "an unregistered kind", {}],
];

/** The digest a proposer records for a field's live value (X71); the checks read only its shape. */
const digest = (field: string) => createHash("sha256").update(field).digest("hex");
/** A sanity payload gets the `before` its `set` needs; anything else is returned as it is. */
function withBefore(payload: unknown): unknown {
  const p = payload as { set?: unknown; before?: unknown } | null;
  if (!p || typeof p !== "object" || typeof p.set !== "object" || p.set === null || "before" in p)
    return payload;
  return { ...p, before: Object.fromEntries(Object.keys(p.set).map((k) => [k, digest(k)])) };
}

const sanityBase = { documentId: "menu", documentType: "page", set: { hours: "Mon to Sat" } };
const BEFORE: [string, string, unknown][] = [
  ["sanity_draft", "its before", { ...sanityBase, before: { hours: digest("hours") } }],
  ["sanity_draft", "no before", sanityBase],
  ["sanity_draft", "an empty before", { ...sanityBase, before: {} }],
  ["sanity_draft", "a before for another field", { ...sanityBase, before: { phone: digest("p") } }],
  [
    "sanity_draft",
    "a before with an extra field",
    { ...sanityBase, before: { hours: digest("h"), phone: digest("p") } },
  ],
  [
    "sanity_draft",
    "an upper-case digest",
    { ...sanityBase, before: { hours: digest("h").toUpperCase() } },
  ],
  ["sanity_draft", "a short digest", { ...sanityBase, before: { hours: digest("h").slice(1) } }],
  ["sanity_draft", "a number for a digest", { ...sanityBase, before: { hours: 5 } }],
  [
    "sanity_draft",
    "an underscore field in before",
    { ...sanityBase, before: { _rev: digest("r") } },
  ],
  ["sanity_draft", "before that is a list", { ...sanityBase, before: [digest("h")] }],
];

describe("the writer's shape checks agree with the inbox's", () => {
  for (const [kind, name, payload] of [
    ...SAME.map(([k, n, p]): [string, string, unknown] => [k, n, withBefore(p)]),
    ...BEFORE,
  ])
    it(`${kind}: ${name}`, () => {
      expect(writer(kind, payload).ok).toBe(inbox(kind, payload).ok);
    });

  it("a sanity payload with its before digests is accepted by both", () => {
    const p = withBefore(sanityBase);
    expect(writer("sanity_draft", p).ok).toBe(true);
    expect(inbox("sanity_draft", p).ok).toBe(true);
  });

  it("a sanity payload without before is refused by both", () => {
    expect(writer("sanity_draft", sanityBase).ok).toBe(false);
    expect(inbox("sanity_draft", sanityBase).ok).toBe(false);
  });
});

describe("the writer accepts nothing the inbox refuses; only its own path list is stricter", () => {
  const OWN_LIST = [
    "CODEOWNERS",
    "docs/CODEOWNERS",
    "package.json",
    "app/package.json",
    "pnpm-lock.yaml",
    "Makefile",
    "Dockerfile",
    "scripts/deploy.sh",
    "a/.gitattributes",
    ".npmrc",
    "package.json.",
    ".vscode/tasks.json",
  ];
  for (const path of OWN_LIST)
    it(`${path}: the inbox admits it, the writer refuses it`, () => {
      expect(isSafeRepoPath(path)).toBe(false);
      expect(writer("pull_request", file(path)).ok).toBe(false);
      expect(inbox("pull_request", file(path)).ok).toBe(true);
    });

  it("a path both accept is the same path", () => {
    for (const path of ["content/menu.md", "public/menu/drinks.json", "docs/guide@v2/notes.md"]) {
      expect(writer("pull_request", file(path)).ok).toBe(true);
      expect(inbox("pull_request", file(path)).ok).toBe(true);
    }
  });
});

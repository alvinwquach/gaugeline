import { readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { WRITER_DIR, publishProblems, writerRuntimeSources } from "../lib/writer-scan.js";

// ADR-0010: a publish call does not exist in the writer's code. This adds to the merge scan; it removes nothing.
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));

describe("writer never publishes: the scan finds each way of asking", () => {
  const caught = [
    'const t = "sanity.action.document." + "pub" + "lish";',
    'const t = "sanity.action.document.\\u0070ublish";',
    'const t = "sanity.action.document.\\x70ublish";',
    'const action = "sanity.action.document.unpublish";',
    "client.action({ actionType: 'sanity.action.document.discard' })",
    "// publishing is the editor's",
    "const PUBLISH = 1;",
  ];
  for (const line of caught)
    it(`refuses: ${line}`, () => {
      expect(publishProblems("x.ts", line).length).toBeGreaterThan(0);
    });

  it("allows what the writer is for: a draft id and a create", () => {
    const ok = 'const body = { mutations: [{ create: { _id: "drafts.menu", _type: "page" } }] };';
    expect(publishProblems("ok.ts", ok)).toEqual([]);
  });

  it("names the file and the line", () => {
    expect(publishProblems("a.ts", "x\nconst p = 'publish';")).toEqual([
      "a.ts:2: a publish word in the writer.",
    ]);
  });
});

describe("writer never publishes: the repository", () => {
  it(`no runtime file in ${WRITER_DIR} names a publish or a discard`, () => {
    const files = writerRuntimeSources(join(repoRoot, WRITER_DIR));
    expect(files.filter((f) => /[\\/]src[\\/].+\.ts$/.test(f)).length).toBeGreaterThanOrEqual(10);
    expect(files.some((f) => /__tests__/.test(f))).toBe(false);
    const problems = files.flatMap((f) =>
      publishProblems(relative(repoRoot, f), readFileSync(f, "utf8")),
    );
    expect(problems).toEqual([]);
  });
});

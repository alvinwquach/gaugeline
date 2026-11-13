import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSource } from "../source.js";

/**
 * docs/guides/versions-config-licence-source.md shows `npx gaugeline source <folder> --only <ids>` and
 * what it prints for an invented business's repository. The docs runner points every example at a
 * fixture website and this command reads a folder, so this test copies the invented folder
 * (packages/fixtures/source/<id>/<kind>) under the name the page uses and runs the command's own code on
 * it, with the same --only. "Passed" lines are left out, as in every docs example.
 */
const page = readFileSync(
  fileURLToPath(
    new URL("../../../../docs/guides/versions-config-licence-source.md", import.meta.url),
  ),
  "utf8",
).replace(/\r\n/g, "\n");

const examples = [
  ...page.matchAll(
    /<!-- source-fixture: ([a-z0-9-]+)\/(fail|pass|unsure) -->\n\n```text title="Terminal"[^\n]*\n\$ npx gaugeline source (\S+) --only (\S+)\n```\n\n```text title=Output\n([\s\S]*?)\n```/g,
  ),
].map((m) => ({
  id: m[1] ?? "",
  kind: m[2] ?? "",
  folder: m[3] ?? "",
  only: (m[4] ?? "").split(","),
  expected: m[5] ?? "",
}));

describe("docs/guides/versions-config-licence-source.md", () => {
  it("has an example for each check, each run with --only", () => {
    expect(examples.map((e) => `${e.id}/${e.kind}`)).toEqual([
      "zod-version-advisory/fail",
      "zod-version-advisory/unsure",
      "next-version-advisory/fail",
      "next-version-advisory/unsure",
    ]);
    for (const e of examples) expect(e.only, e.id).toContain(e.id);
  });

  it("promises what the command promises", () => {
    expect(page).toContain("make no request and run no code");
    expect(page).toContain("never open a `.env` file");
    expect(page).toContain("Documentation checked on:");
  });

  let base: string;
  beforeEach(() => {
    base = realpathSync(mkdtempSync(join(tmpdir(), "gl-source-docs-")));
  });
  afterEach(() => {
    rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  });

  it.each(examples)(
    "prints $id/$kind as the page shows it",
    async ({ id, kind, folder, only, expected }) => {
      expect(folder).toMatch(/^\.\/[a-z-]+$/);
      cpSync(
        fileURLToPath(new URL(`../../../fixtures/source/${id}/${kind}`, import.meta.url)),
        join(base, folder),
        { recursive: true },
      );
      let out = "";
      await runSource(
        { folder, only, json: false, quiet: false },
        { stdout: { write: (t) => (out += t) }, stderr: { write: () => true } },
        { cwd: base, now: new Date("2026-11-11T12:00:00Z"), color: false },
      );
      const printed = out
        .split("\n")
        .filter((l) => !/^✓ [a-z0-9-]+$/.test(l))
        .join("\n")
        .replace(/\n+$/, "");
      expect(printed).toBe(expected);
    },
  );
});

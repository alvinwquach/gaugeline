import { cpSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runSource } from "../source.js";

/**
 * docs/guides/webhook-and-cache-source.md shows `npx gaugeline source <folder>` and what it prints for
 * an invented business's repository. The docs runner points every example at a fixture website and this
 * command reads a folder, so this test copies the invented folder (packages/fixtures/source/<id>/<kind>)
 * under the name the page uses and runs the command's own code on it. "Passed" lines are left out, as in
 * every docs example.
 */
const page = readFileSync(
  fileURLToPath(new URL("../../../../docs/guides/webhook-and-cache-source.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

const examples = [
  ...page.matchAll(
    /<!-- source-fixture: ([a-z0-9-]+)\/(fail|pass) -->\n\n```sh title=Terminal[^\n]*\n(\$ [^\n]+)\n```\n\n```sh title=Output\n([\s\S]*?)\n```/g,
  ),
].map((m) => ({ id: m[1] ?? "", kind: m[2] ?? "", command: m[3] ?? "", expected: m[4] ?? "" }));

describe("docs/guides/webhook-and-cache-source.md", () => {
  it("has an example for each check", () => {
    expect(examples.map((e) => e.id)).toEqual([
      "webhook-missing-secret-status",
      "sanity-cdn-tagged-reads",
      "webhook-signature-compared-plainly",
      "webhook-timestamp-unbounded",
      "webhook-body-read-unsafely",
      "webhook-logs-private-values",
      "revalidate-time-and-tag-mixed",
    ]);
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
    async ({ id, kind, command, expected }) => {
      const folder = command.replace("$ npx gaugeline source ", "");
      expect(folder).toMatch(/^\.\/[a-z-]+$/);
      cpSync(
        fileURLToPath(new URL(`../../../fixtures/source/${id}/${kind}`, import.meta.url)),
        join(base, folder),
        { recursive: true },
      );
      let out = "";
      await runSource(
        { folder, json: false, quiet: false },
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

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { readLocalSource, runStaticChecks, type RunResult } from "@gaugeline/core";
import { formatTerminal } from "../reporter.js";

/**
 * docs/guides/webhook-and-cache-source.md shows what the static checks print for an invented bar's
 * repository. The command that runs them on a folder arrives with the indexing checks, so this test runs
 * the same checks through the core entry point on the same invented folder
 * (packages/fixtures/source/<id>/<kind>) and prints the report with the CLI's own terminal formatter,
 * the way the page's Output block must read. "Passed" lines are left out, as in every docs example.
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
    ]);
  });

  it.each(examples)(
    "prints $id/$kind as the page shows it",
    async ({ id, kind, command, expected }) => {
      const folder = command.replace("$ npx gaugeline source ", "");
      expect([
        "./harbor-lane-taproom",
        "./bluebell-clinic",
        "./fennel-lane-bakery",
        "./marlowe-street-dental",
      ]).toContain(folder);
      const tree = await readLocalSource(
        fileURLToPath(new URL(`../../../fixtures/source/${id}/${kind}`, import.meta.url)),
        undefined,
        "./harbor-lane-taproom",
      );
      const r = await runStaticChecks({ tree, now: new Date("2026-11-11T12:00:00Z") });
      const run: RunResult = {
        findings: r.findings,
        passed: r.passed,
        failed: [],
        warnings: [],
        couldNotCheck: r.couldNotCheck,
        sampled: {},
      };
      const printed = formatTerminal({ result: run, color: false })
        .split("\n")
        .filter((l) => !/^✓ [a-z0-9-]+$/.test(l))
        .join("\n")
        .replace(/\n+$/, "");
      expect(printed).toBe(expected);
    },
  );
});

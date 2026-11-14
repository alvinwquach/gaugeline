import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { formatSarif, renderReport } from "../../../index.js";
import { readLocalSource, type SourceTree } from "../../../local-source/read.js";
import { STATIC_CHECKS, createStaticRegistry, runStaticChecks } from "../../../local-source/run.js";
import type { Result } from "../../../result.js";

export const NOW = new Date("2026-11-13T12:00:00Z");

/** A folder under packages/fixtures/source, read with the real reader. */
export const fixtureTree = (...parts: string[]): Promise<SourceTree> =>
  readLocalSource(
    fileURLToPath(new URL(`../../../../../fixtures/source/${parts.join("/")}`, import.meta.url)),
    undefined,
    "./site",
  );

/** A tree from `{ path: text }`, as the reader would hand it over. */
export const treeOf = (
  files: Record<string, string>,
  over: Partial<SourceTree> = {},
): SourceTree => ({
  kind: "local-source",
  label: "./site",
  files: new Map(Object.entries(files)),
  skipped: new Map(),
  truncated: false,
  ...over,
});

/** Runs one check of the static pack on a tree. */
export const runOne = (id: string, tree: SourceTree): Promise<Result> =>
  runStaticChecks({ tree, now: NOW, only: [id] });

/** `file:line` of each finding, in order. */
export const spots = (result: Result): string[] =>
  result.findings.map((f) => `${f.source?.file ?? "?"}:${f.source?.line ?? 0}`);

/** Everything a person or a pipeline can read a result through: JSON, SARIF and the HTML report. */
export function everyOutput(result: Result): string[] {
  const registry = createStaticRegistry();
  return [
    JSON.stringify(result),
    formatSarif(result, { registry, version: "0.0.0" }),
    renderReport({
      result: {
        findings: result.findings,
        passed: result.passed,
        failed: [],
        warnings: [],
        couldNotCheck: result.couldNotCheck,
        sampled: {},
      },
      url: result.url,
      startedAt: NOW,
      registry,
      version: "0.0.0",
    }),
  ];
}

/** The text of a fake secret never reaches any output (CLAUDE.md rule 6, FF-18 to FF-24). */
export function expectNoneOf(result: Result, secrets: readonly string[]): void {
  expect(result.findings.length).toBeGreaterThan(0);
  for (const out of everyOutput(result)) for (const s of secrets) expect(out).not.toContain(s);
}

export const registered = (id: string): boolean => STATIC_CHECKS.some((c) => c.id === id);

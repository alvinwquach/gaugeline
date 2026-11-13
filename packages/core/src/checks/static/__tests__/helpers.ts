import { fileURLToPath } from "node:url";
import { CheckRegistry, type Check } from "../../../model.js";
import { readLocalSource, type SkipReason, type SourceTree } from "../../../local-source/read.js";
import { runStaticChecks, type LocalSourceInput } from "../../../local-source/run.js";

export const NOW = new Date("2026-11-13T12:00:00Z");

/** A folder's files held in memory: the reader's output without a disk. */
export const treeOf = (
  files: Record<string, string>,
  over: { skipped?: Record<string, SkipReason>; truncated?: boolean; label?: string } = {},
): SourceTree => ({
  kind: "local-source",
  label: over.label ?? "./my-site",
  files: new Map(Object.entries(files)),
  skipped: new Map(Object.entries(over.skipped ?? {})),
  truncated: over.truncated ?? false,
});

/** Runs one check on a tree through the same runner the pack uses. */
export const runOne = (check: Check<LocalSourceInput>, tree: SourceTree) =>
  runStaticChecks({ tree, now: NOW, registry: new CheckRegistry().register(check) });

/** An invented fixture folder under packages/fixtures/source, read the way a person's folder is. */
export const fixtureTree = (id: string, kind: "fail" | "pass"): Promise<SourceTree> =>
  readLocalSource(
    fileURLToPath(new URL(`../../../../../fixtures/source/${id}/${kind}`, import.meta.url)),
    undefined,
    `./${id}/${kind}`,
  );

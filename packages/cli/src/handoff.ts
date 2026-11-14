import { HANDOFF_FILES, handoffFiles, type HandoffSummary } from "@gaugeline/core";
import { HANDOFF_DEFAULT_OUT, type HandoffFlags } from "./args.js";
import { inspectScaffold, writeScaffold, type ScaffoldFs } from "./scaffold-write.js";

/**
 * Where the report goes: the folder --out names, or gaugeline-handoff, and nowhere with --json and no
 * --out (the summary is printed instead).
 */
export function handoffFolder(flags: HandoffFlags, json: boolean): string | undefined {
  return flags.out ?? (json ? undefined : HANDOFF_DEFAULT_OUT);
}

/**
 * Check where the report would go before the site is asked anything: a folder outside this one, a link,
 * a file where the folder should be, or a report that is already there without --force is exit 2 now
 * and not after the reads. Reads and writes nothing.
 */
export async function checkHandoffTarget(
  flags: HandoffFlags,
  opts: { cwd: string; json: boolean; fs?: ScaffoldFs },
): Promise<void> {
  const folder = handoffFolder(flags, opts.json);
  if (folder === undefined) return;
  await inspectScaffold(
    HANDOFF_FILES.map((name) => ({ name })),
    folder,
    { force: flags.force, cwd: opts.cwd, ...(opts.fs ? { fs: opts.fs } : {}) },
  );
}

/**
 * Put the three files where the person asked, through the one safe writer (inside this folder, never over
 * a file without --force, all three or none). Returns the folder as typed, or undefined when nothing was
 * written. The command only formats: the reads happened before this.
 */
export async function writeHandoff(opts: {
  flags: HandoffFlags;
  json: boolean;
  summary: HandoffSummary;
  cwd: string;
  fs?: ScaffoldFs;
}): Promise<string | undefined> {
  const folder = handoffFolder(opts.flags, opts.json);
  if (folder === undefined) return undefined;
  await writeScaffold(handoffFiles(opts.summary), folder, {
    force: opts.flags.force,
    cwd: opts.cwd,
    ...(opts.fs ? { fs: opts.fs } : {}),
  });
  return folder;
}

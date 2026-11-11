import { briefMarkdown, type CheckRegistry, type Result } from "@gaugeline/core";
import type { BriefFlags } from "./args.js";
import { inspectBaselineFile, writeBaselineFile, type ScaffoldFs } from "./scaffold-write.js";

/** How the work order's file is named in messages and hints. */
const FILE = { flag: "--out", example: "work-order.md" } as const;

/**
 * Check where --out would write, before the site is asked anything: a file outside this folder, a link,
 * a folder, or a file that is already there without --force is exit 2 now and not after a whole check.
 * Reads and writes nothing.
 */
export async function checkBriefTarget(
  flags: BriefFlags,
  opts: { cwd: string; fs?: ScaffoldFs },
): Promise<void> {
  if (flags.out === undefined) return;
  await inspectBaselineFile(flags.out, { force: flags.force, ...opts, ...FILE });
}

/**
 * Turn the finished result into the work order and put it where the person asked: on stdout, or in
 * the file --out names through the one safe writer (inside this folder, never over a file without
 * --force, all or nothing). The command only formats: the check that made the result ran before this.
 */
export async function emitBrief(opts: {
  flags: BriefFlags;
  result: Result;
  registry: CheckRegistry;
  cwd: string;
  fs?: ScaffoldFs;
  stdout: { write(chunk: string): unknown };
  stderr: { write(chunk: string): unknown };
  quiet: boolean;
}): Promise<void> {
  const { flags, result } = opts;
  const text = briefMarkdown(result, opts.registry, {
    ...(flags.business !== undefined ? { business: flags.business } : {}),
    ...(flags.hoursPerPoint !== undefined ? { hoursPerPoint: flags.hoursPerPoint } : {}),
    ...(flags.rateMinor !== undefined ? { rateMinor: flags.rateMinor } : {}),
  });
  if (flags.rateMinor !== undefined && flags.hoursPerPoint === undefined && !opts.quiet)
    opts.stderr.write(
      "--rate is used only with --hours-per-point, so the work order shows points only.\n",
    );
  if (flags.out === undefined) {
    opts.stdout.write(text);
    return;
  }
  await writeBaselineFile(flags.out, text, {
    force: flags.force,
    cwd: opts.cwd,
    ...(opts.fs ? { fs: opts.fs } : {}),
    ...FILE,
  });
  if (!opts.quiet) opts.stderr.write(`Work order written to ${flags.out}\n`);
}

import {
  EVAL_SETS,
  evalFailureCount,
  formatEvalSuite,
  runEvalSets,
  type EvalSet,
  type Outcome,
} from "@gaugeline/core";
import type { ParsedArgs } from "./args.js";
import { inspectBaselineFile, writeBaselineFile, type ScaffoldFs } from "./scaffold-write.js";

interface Out {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
}
type EvalsArgs = Extract<ParsedArgs, { kind: "evals" }>;

/** How the report's file is named in messages and hints. */
const FILE = { flag: "--out", example: "evals.json" } as const;

/**
 * gaugeline evals: run the offline eval sets (core's recorded replay: no key, no network, no secret) and
 * print each agent's pass rate, refusal rate and cost, then write the same numbers to a JSON file. The
 * file's place is checked first, so a file that is in the way is exit 2 before any set is run, and the file
 * is written through the one safe writer (inside this folder, never over a file without --force). Exit 1
 * when a golden case failed or a known-bad case was not caught; 2 (a ConfigError) when it could not run or
 * could not write. The environment is never read: there is no live mode, and no key can reach the output.
 */
export async function runEvalsCommand(
  args: EvalsArgs,
  io: Out,
  deps: { cwd: string; sets?: readonly EvalSet[]; fs?: ScaffoldFs },
): Promise<Outcome> {
  const fs = deps.fs ? { fs: deps.fs } : {};
  await inspectBaselineFile(args.out, { force: args.force, cwd: deps.cwd, ...fs, ...FILE });
  const suite = await runEvalSets(deps.sets ?? EVAL_SETS, {
    ...(args.agent !== undefined ? { agents: [args.agent] } : {}),
  });
  io.stdout.write(`${formatEvalSuite(suite)}\n`);
  // Written after the results are shown: if the file cannot be written, the numbers are still on the screen.
  await writeBaselineFile(args.out, `${JSON.stringify(suite, null, 2)}\n`, {
    force: args.force,
    cwd: deps.cwd,
    ...fs,
    ...FILE,
  });
  if (!args.quiet) io.stderr.write(`Report written to ${args.out}\n`);
  return { kind: "ran", highFindings: evalFailureCount(suite), drift: false };
}

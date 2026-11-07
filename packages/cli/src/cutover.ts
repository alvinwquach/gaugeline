import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ConfigError,
  createBudget,
  createCutoverRegistry,
  runChecks,
  type CutoverSnapshot,
  type Outcome,
} from "@gaugeline/core";
import { formatTerminal } from "./reporter.js";
import { readCutoverConfig } from "./schema-config.js";
import { REGISTRATION_NOTE, takeSnapshot, type CutoverDeps, type CutoverIo } from "./snapshot.js";

function readBefore(path: string, shown: string): CutoverSnapshot {
  if (!existsSync(path))
    throw new ConfigError(`${shown} does not exist.`, {
      hint: "Take one before cutover with gaugeline snapshot example.com --out before.json.",
    });
  let data: Partial<CutoverSnapshot>;
  try {
    data = JSON.parse(readFileSync(path, "utf8")) as Partial<CutoverSnapshot>;
  } catch (err) {
    throw new ConfigError(`${shown} is not valid JSON: ${(err as Error).message}`);
  }
  if (data?.schema !== 1 || typeof data.domain !== "string" || !data.records || !data.hosts)
    throw new ConfigError(`${shown} is not a snapshot written by gaugeline snapshot.`);
  return data as CutoverSnapshot;
}

/** gaugeline cutover --before before.json */
export async function runCutover(
  args: { before: string; allowPrivate: boolean; quiet: boolean },
  io: CutoverIo & { color: boolean },
  deps: CutoverDeps,
): Promise<Outcome> {
  const cwd = deps.cwd ?? process.cwd();
  const before = readBefore(resolve(cwd, args.before), args.before);
  const config = readCutoverConfig(cwd);
  // The selectors read before are read again, with any the config adds.
  const selectors = [
    ...new Set([...Object.keys(before.records.dkim), ...(config?.dkimSelectors ?? [])]),
  ];
  const now = await takeSnapshot(
    before.domain,
    { allowPrivate: args.allowPrivate, selectors },
    deps,
  );
  const result = await runChecks(
    { before, now, ...(config?.expectedChanges ? { expected: config.expectedChanges } : {}) },
    createCutoverRegistry(),
    { ctx: { ...(deps.now ? { now: deps.now } : {}) } },
  );
  io.stdout.write(
    `Comparing ${before.domain} with ${args.before} (taken ${before.takenAt.slice(0, 16).replace("T", " ")} UTC)\n`,
  );
  io.stdout.write(
    formatTerminal({
      result,
      sampled: createBudget().summary(),
      color: io.color,
      origin: `https://${before.domain}`,
    }),
  );
  if (!args.quiet) {
    for (const e of config?.expectedChanges ?? [])
      io.stderr.write(`Expected change, not reported: ${e.record} (${e.reason})\n`);
    io.stderr.write(`${REGISTRATION_NOTE}\n`);
  }
  return {
    kind: "ran",
    highFindings: result.findings.filter((f) => f.severity === "high").length,
    drift: result.findings.length > 0,
    incomplete: result.couldNotCheck.length > 0,
  };
}

import {
  ConfigError,
  MAX_RULES,
  SANITY_DATASET,
  SANITY_PROJECT_ID,
  SANITY_TOKEN,
  compareGenerated,
  createFetcher,
  freezeEnv,
  parseRefsRule,
  parseTotalsRule,
  type FetcherOptions,
  type Outcome,
} from "@gaugeline/core";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { formatTerminal } from "./reporter.js";

interface Out {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
  env?: Record<string, string | undefined>;
}

interface Deps {
  cwd: string;
  now?: Date;
  fetcher?: FetcherOptions;
  color?: boolean;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * gaugeline query <folder> --totals "type:stated=parts" --refs "type:path": content that software
 * wrote has to add up. Each rule is one GET of the query endpoint (published documents), and the
 * dataset does the comparing: what comes back is ids and whole numbers, never a stated number, a
 * part or any other field. Both flags may repeat, at most ten rules in all. A rule that does not
 * parse is exit 2 with the character it went wrong at, before anything is asked. The folder is
 * checked to exist, as for the other query modes, and is not read. Needs SANITY_PROJECT_ID. Exit
 * 0, 1 with --ci and a fix-first finding, or 2 (a ConfigError).
 */
export async function runGenerated(
  args: {
    dir: string;
    generated: { totals: readonly string[]; refs: readonly string[] };
    json?: boolean;
    allowPrivate?: boolean;
    quiet?: boolean;
  },
  io: Out,
  deps: Deps,
): Promise<Outcome> {
  // A rule given twice is one rule.
  const totalsText = [...new Set(args.generated.totals)];
  const refsText = [...new Set(args.generated.refs)];
  if (totalsText.length + refsText.length > MAX_RULES)
    throw new ConfigError(
      `${totalsText.length + refsText.length} rules were given, and a run takes at most ${MAX_RULES} (--totals and --refs together).`,
      { hint: "Run the rest in a second command." },
    );
  // Every rule is read first: a rule that does not parse stops the command before anything is asked.
  const totals = totalsText.map(parseTotalsRule);
  const refs = refsText.map(parseRefsRule);
  const folder = resolve(deps.cwd, args.dir);
  const info = await stat(folder).catch(() => null);
  if (info === null || !info.isDirectory())
    throw new ConfigError(
      info ? `${args.dir} is a file, not a folder.` : `The folder ${args.dir} does not exist.`,
      {
        hint: 'Give the folder of your site\'s source: gaugeline query ./src --refs "mealPlan:meals"',
      },
    );
  if ((io.env?.[SANITY_PROJECT_ID] ?? "").trim() === "")
    throw new ConfigError(
      "gaugeline query --totals and --refs ask your dataset about published documents, and that needs SANITY_PROJECT_ID.",
      {
        hint: "Set SANITY_PROJECT_ID (and SANITY_TOKEN, with the Viewer role, for a private dataset).",
      },
    );
  const run = await compareGenerated({
    totals,
    refs,
    env: freezeEnv(io.env ?? {}, [SANITY_PROJECT_ID, SANITY_DATASET, SANITY_TOKEN]),
    fetcher: createFetcher({
      ...deps.fetcher,
      ...(args.allowPrivate === true ? { allowPrivate: true } : {}),
    }),
    now: deps.now ?? new Date(),
  });
  if (args.quiet !== true) for (const n of run.notices) io.stderr.write(`${n}\n`);
  const outcome: Outcome = {
    kind: "ran",
    highFindings: run.result.findings.filter((f) => f.severity === "high").length,
    drift: false,
  };
  if (args.json) {
    io.stdout.write(`${JSON.stringify(run.result, null, 2)}\n`);
    return outcome;
  }
  const rules = [
    ...(totals.length > 0 ? [plural(totals.length, "--totals rule")] : []),
    ...(refs.length > 0 ? [plural(refs.length, "--refs rule")] : []),
  ].join(" and ");
  io.stdout.write(
    [
      `Asked the dataset about ${rules}: one request each, published documents only. The dataset did the comparing and sent back ids and counts, so no stated number, part or other field was read.`,
      "",
      formatTerminal({
        result: {
          findings: run.result.findings,
          passed: run.result.passed,
          failed: [],
          warnings: [],
          couldNotCheck: run.result.couldNotCheck,
          sampled: {},
        },
        color: deps.color ?? false,
      }).trimEnd(),
    ].join("\n") + "\n",
  );
  return outcome;
}

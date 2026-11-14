import { resolve } from "node:path";
import { AdsInputError, loadAdsFile } from "@gaugeline/app-server";
import {
  ConfigError,
  createFetcher,
  formatDestinationLines,
  summarySentence,
  type FetcherOptions,
  type Outcome,
} from "@gaugeline/core";
import { adsEngine } from "./ads-engine.js";
import { formatTerminal } from "./reporter.js";

/**
 * gaugeline ads <export.csv>: read a Meta or Google Ads export and print one line per landing page,
 * its number of ads and its spend, highest first. The file is read once (by the same function the
 * app uses, so a UTF-16 export works in both). Then each landing page is asked for once, through the
 * fetcher (GET only, five at a time), and what the checks found is printed under the lines, then
 * one sentence per currency with the spend that went to pages with problems (nothing when none did).
 * `--json` prints the schema 2 result and nothing else: the summary is in the app API beside it.
 *
 * Warnings (rows skipped, ambiguous amounts) go to stderr, so stdout holds only the lines, or with
 * --json only the result. --quiet leaves the warnings out.
 */
export async function runAds(
  args: { file: string; json: boolean; quiet: boolean; allowPrivate?: boolean; ci?: boolean },
  io: {
    stdout: { write(s: string): unknown };
    stderr: { write(s: string): unknown };
  },
  deps: { cwd: string; now: Date; fetcher?: FetcherOptions; color?: boolean },
): Promise<Outcome> {
  let input;
  try {
    input = loadAdsFile(resolve(deps.cwd, args.file), adsEngine);
  } catch (err) {
    if (err instanceof AdsInputError) throw new ConfigError(err.message);
    throw err;
  }
  const outcome = await adsEngine.check(input.parsed, {
    fetcher: createFetcher({
      ...deps.fetcher,
      ...(args.allowPrivate ? { allowPrivate: true } : {}),
    }),
    now: deps.now,
    onProgress: (text) => {
      if (!args.quiet) io.stderr.write(`${text}\n`);
    },
  });
  if (args.json) io.stdout.write(`${JSON.stringify(outcome.result, null, 2)}\n`);
  else {
    for (const line of formatDestinationLines(input.parsed.groups)) io.stdout.write(`${line}\n`);
    // What the checks said goes under the lines, and only when there is something to say.
    const { findings, couldNotCheck, passed } = outcome.result;
    if (findings.length > 0 || couldNotCheck.length > 0)
      io.stdout.write(
        `\n${formatTerminal({
          result: { findings, passed, failed: [], warnings: [], couldNotCheck, sampled: {} },
          color: deps.color ?? false,
        })}`,
      );
    const sentences = (outcome.ads.summary ?? []).flatMap((s) => summarySentence(s) ?? []);
    if (sentences.length > 0) io.stdout.write(`\n${sentences.join("\n")}\n`);
  }
  const findings = outcome.result.findings;
  return {
    kind: "ran",
    highFindings: findings.filter((f) => f.severity === "high").length,
    drift: findings.length > 0,
  };
}

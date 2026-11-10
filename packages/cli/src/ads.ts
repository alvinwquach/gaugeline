import { resolve } from "node:path";
import { AdsInputError, loadAdsFile } from "@gaugeline/app-server";
import {
  ConfigError,
  createFetcher,
  formatDestinationLines,
  type FetcherOptions,
  type Outcome,
} from "@gaugeline/core";
import { adsEngine } from "./ads-engine.js";

/**
 * gaugeline ads <export.csv>: read a Meta or Google Ads export and print one line per landing page,
 * its number of ads and its spend, highest first. The file is read once (by the same function the
 * app uses, so a UTF-16 export works in both) and no request is sent; the fetcher is made because
 * the engine's checks, which come after this, are given one.
 *
 * Warnings (rows skipped, ambiguous amounts) go to stderr, so stdout holds only the lines, or with
 * --json only the result. --quiet leaves the warnings out.
 */
export async function runAds(
  args: { file: string; json: boolean; quiet: boolean },
  io: {
    stdout: { write(s: string): unknown };
    stderr: { write(s: string): unknown };
  },
  deps: { cwd: string; now: Date; fetcher?: FetcherOptions },
): Promise<Outcome> {
  let input;
  try {
    input = loadAdsFile(resolve(deps.cwd, args.file), adsEngine);
  } catch (err) {
    if (err instanceof AdsInputError) throw new ConfigError(err.message);
    throw err;
  }
  const outcome = await adsEngine.check(input.parsed, {
    fetcher: createFetcher(deps.fetcher),
    now: deps.now,
    onProgress: (text) => {
      if (!args.quiet) io.stderr.write(`${text}\n`);
    },
  });
  if (args.json) io.stdout.write(`${JSON.stringify(outcome.result, null, 2)}\n`);
  else for (const line of formatDestinationLines(input.parsed.groups)) io.stdout.write(`${line}\n`);
  const findings = outcome.result.findings;
  return {
    kind: "ran",
    highFindings: findings.filter((f) => f.severity === "high").length,
    drift: findings.length > 0,
  };
}

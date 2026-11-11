import { statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { checkEmails, createFetcher, type FetcherOptions, type Outcome } from "@gaugeline/core";
import { formatTerminal } from "./reporter.js";
import { readEmailsConfig, readFacts, readLanguageRules, readPayments } from "./schema-config.js";

interface Out {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
}

interface Deps {
  cwd: string;
  now?: Date;
  fetcher?: FetcherOptions;
  color?: boolean;
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/**
 * gaugeline emails <folder>: check the rendered emails a project's export wrote. The files are read
 * as text and never run, rendered or sent. The settings files in the working folder (payments, facts,
 * languages, emails) are the ones the page check reads. With `--base` the site's own links and
 * images are asked for (GET or HEAD, the same limits as a page); without it nothing is requested.
 * Exit 0, 1 with --ci and a "Fix this first" finding, or 2 (no such folder, no .html in it, a
 * settings file that does not read).
 */
export async function runEmails(
  args: { dir: string; base?: string; json?: boolean; allowPrivate?: boolean; quiet?: boolean },
  io: Out,
  deps: Deps,
): Promise<Outcome> {
  const folder = resolve(deps.cwd, args.dir);
  // The folder as typed goes in front of each file, so a line reads as a path from where the command ran.
  let typed = args.dir
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .replace(/^(?:\.\/)+/, "");
  try {
    if (statSync(folder).isFile()) typed = dirname(typed);
  } catch {
    // core says the folder does not exist
  }
  const prefix = typed === "." ? "" : typed;
  const languageRules = readLanguageRules(deps.cwd);
  const facts = readFacts(deps.cwd);
  const payments = readPayments(deps.cwd);
  const config = readEmailsConfig(deps.cwd);
  const run = await checkEmails({
    dir: folder,
    prefix,
    ...(args.base !== undefined ? { base: args.base } : {}),
    fetcher: createFetcher({
      ...deps.fetcher,
      ...(args.allowPrivate === true && args.base !== undefined
        ? { allowPrivate: true, target: args.base }
        : {}),
    }),
    ...(config ? { config } : {}),
    ...(facts ? { facts } : {}),
    ...(payments ? { payments } : {}),
    ...(languageRules ? { languageRules } : {}),
    ...(deps.now ? { now: () => deps.now as Date } : {}),
  });
  const { result } = run;
  const outcome: Outcome = {
    kind: "ran",
    highFindings: result.findings.filter((f) => f.severity === "high").length,
    drift: false,
  };
  if (args.json) {
    io.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (args.quiet !== true) for (const n of run.notes) io.stderr.write(`${n}\n`);
    return outcome;
  }
  const texts = run.emails.filter((e) => e.text).length;
  const where = prefix === "" ? "this folder" : prefix;
  const out: string[] = [
    `Read ${plural(run.emails.length, "email")} in ${where}${
      run.languages.length > 0 ? ` (${run.languages.join(", ")})` : ""
    }, ${texts} with a text version. Nothing was rendered, run or sent.`,
    run.requested && args.base !== undefined
      ? `Asked ${new URL(args.base).origin} for the links and images the emails point at it, GET or HEAD only, up to 30 links and 20 images for each email. Other sites were not asked.`
      : "No request was made. Add --base https://your-site.example to check the links and images on your site.",
  ];
  for (const n of run.notes) out.push(`Note: ${n}`);
  out.push(
    "",
    formatTerminal({
      result: {
        findings: result.findings,
        passed: result.passed,
        failed: result.failed.map((id) => ({ id, error: "did not run" })),
        warnings: [],
        couldNotCheck: result.couldNotCheck,
        sampled: {},
      },
      sampled: run.budget,
      color: deps.color ?? false,
    }).trimEnd(),
  );
  io.stdout.write(`${out.join("\n")}\n`);
  return outcome;
}

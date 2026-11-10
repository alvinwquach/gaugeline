import {
  ConfigError,
  checkRoutes,
  createFetcher,
  findAppDir,
  type FetcherOptions,
  type Outcome,
  type RouteAnswer,
} from "@gaugeline/core";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { formatTerminal } from "./reporter.js";

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

interface Out {
  stdout: { write(s: string): unknown };
  stderr: { write(s: string): unknown };
}

interface Deps {
  cwd: string;
  now?: Date;
  fetcher?: FetcherOptions;
  color?: boolean;
  /** Which of --owner-consent and gaugeline.consent.json gave consent, for the notice. Absent: no consent. */
  consent?: string;
}

/** What one asked route answered, in a few words and numbers. Never the body. */
function describe(a: RouteAnswer): string {
  const status = a.status === undefined ? "" : ` (${a.status})`;
  switch (a.result) {
    case "refused":
      return a.signInForm
        ? `refused: answered with a sign-in form (${a.status})`
        : `refused${status}`;
    case "redirected-to-login":
      return `redirected to ${a.to ?? "another address"}${status}`;
    case "not-found":
      return `not found${status}`;
    case "handed-over":
      return a.empty === true
        ? `handed over: empty body${status}`
        : `handed over${status}, ${a.capped === true && a.contentLength === undefined ? `at least ${a.bytes ?? 0}` : (a.contentLength ?? a.bytes ?? 0)} bytes`;
    case "error":
      return `could not be judged${status}`;
  }
}

/**
 * gaugeline check <folder> --routes --base <address>: read the Next.js routes in the folder, and
 * ask the running site for each one the code treats as signed-in only, with no session. A probing
 * check (CLAUDE.md rule 14): it runs only with --owner-consent or a gaugeline.consent.json, and
 * says so before it asks. One GET each, at most 30, five at a time, with no cookie and no
 * Authorization header; there is no option to send a session. The folder is read as text and never
 * run. Exit 0, 1 with --ci and a handed-over page, or 2 (a ConfigError: no consent, no such
 * folder, no app directory in it, or an address that cannot be asked).
 */
export async function runRoutes(
  args: { dir: string; base: string; json?: boolean; allowPrivate?: boolean; quiet?: boolean },
  io: Out,
  deps: Deps,
): Promise<Outcome> {
  if (deps.consent === undefined)
    throw new ConfigError(
      "gaugeline check --routes asks each signed-in route for its page with no session, which is a probing check, so it runs only with --owner-consent.",
      {
        hint: "Add --owner-consent (or a gaugeline.consent.json) on a site you own or have permission to test.",
      },
    );
  const folder = resolve(deps.cwd, args.dir);
  const info = await stat(folder).catch(() => null);
  if (info === null || !info.isDirectory())
    throw new ConfigError(
      info ? `${args.dir} is a file, not a folder.` : `The folder ${args.dir} does not exist.`,
      {
        hint: "Give the folder of your site's source: gaugeline check ./src --routes --base https://example.com",
      },
    );
  if ((await findAppDir(folder)) === undefined)
    throw new ConfigError(`No Next.js app folder found in ${args.dir}.`, {
      hint: "Gaugeline reads app/ or src/app/ inside the folder (the app router). The pages router is not read yet.",
    });
  // Windows separators and a trailing slash go; "." prints as nothing, so files read like paths from here.
  const typed = args.dir.replace(/\\/g, "/").replace(/\/+$/, "");
  if (args.quiet !== true)
    io.stderr.write(
      `Probing checks are on (${deps.consent}): route-hidden-not-protected asks each signed-in route for its page with no session. Run only on sites you own or have permission to test.\n`,
    );
  const run = await checkRoutes({
    dir: folder,
    base: args.base,
    fetcher: createFetcher({
      ...deps.fetcher,
      ...(args.allowPrivate === true ? { allowPrivate: true, target: args.base } : {}),
    }),
    now: deps.now ?? new Date(),
    ownerConsent: true,
    prefix: typed === "." ? "" : typed,
  });
  const outcome: Outcome = {
    kind: "ran",
    highFindings: run.result.findings.filter((f) => f.severity === "high").length,
    drift: false,
  };
  if (args.json) {
    io.stdout.write(`${JSON.stringify(run.result, null, 2)}\n`);
    return outcome;
  }

  const guarded = run.routes.filter((r) => r.expectsSession);
  const where = [typed === "" ? "." : typed, run.appDir === "." ? "" : run.appDir]
    .filter((x) => x !== "" && x !== undefined)
    .join("/");
  const open = run.routes.length - guarded.length;
  const out: string[] = [
    `Read ${plural(run.routes.length, "route")} under ${where}: ${guarded.length} ${guarded.length === 1 ? "expects" : "expect"} a session in the code, ${open} ${open === 1 ? "does" : "do"} not. Asked ${plural(run.answers.size, "route")} once each with no session (GET only, no cookie, no Authorization header); no page was stored.`,
  ];
  for (const n of run.notes) out.push(`Note: ${n}`);
  if (run.answers.size > 0) {
    out.push("", "What each route answered:");
    const width = Math.max(...[...run.answers.keys()].map((p) => p.length));
    for (const [path, a] of [...run.answers].sort((x, y) => (x[0] < y[0] ? -1 : 1)))
      out.push(`  ${path.padEnd(width)}  ${describe(a)}`);
  }
  out.push(
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
  );
  io.stdout.write(`${out.join("\n")}\n`);
  return outcome;
}

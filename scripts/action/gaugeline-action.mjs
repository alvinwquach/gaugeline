// @ts-check
/**
 * The logic of action.yml: run the published CLI, keep its SARIF, and decide whether the job fails.
 * Plain Node, no dependencies, so the action runs on any runner with Node and the file is tested as
 * it ships.
 *
 * It makes no HTTP request of its own: not to the checked site (that is the CLI's job, and the CLI
 * only reads), and not to GitHub's API. The SARIF is uploaded by the official upload-sarif step in
 * action.yml. A test asserts this file has no network code.
 */
import { execFile } from "node:child_process";
import { appendFileSync, writeFileSync } from "node:fs";

/** An exact release: 1.2.3, or 1.2.3-rc.1. Not a tag, a range, a URL or another package. */
const EXACT_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const VERSION_MESSAGE =
  "The version input must be an exact release number such as 1.2.3 (the release you pin), not a tag, a range, a URL or another package.";

/**
 * What the SARIF log says: findings by level (muted ones, with a SARIF suppression, left out).
 * @param {string} sarifText
 */
export function summarise(sarifText) {
  const log = JSON.parse(sarifText);
  const results = (log.runs?.[0]?.results ?? []).filter(
    (/** @type {{ suppressions?: unknown[] }} */ r) =>
      !r.suppressions || r.suppressions.length === 0,
  );
  const count = (/** @type {string} */ level) =>
    results.filter((/** @type {{ level?: string }} */ r) => r.level === level).length;
  return {
    high: count("error"),
    medium: count("warning"),
    low: count("note"),
    total: results.length,
  };
}

/**
 * Whether the job should fail, from the CLI's exit code and the findings.
 * 2 (the check could not run) always fails: a job that checked nothing must not look green.
 * @param {{ exit: number, failOn: string, summary: ReturnType<typeof summarise> | undefined }} a
 */
export function decide({ exit, failOn, summary }) {
  if (exit === 2 || !summary) return { fail: true, reason: "Gaugeline could not run the check." };
  if (failOn === "never") return { fail: false, reason: "" };
  const n = failOn === "medium" ? summary.high + summary.medium : summary.high;
  return n > 0
    ? { fail: true, reason: `${n} finding${n === 1 ? "" : "s"} at or above "${failOn}".` }
    : { fail: false, reason: "" };
}

/**
 * The whole step. Inputs come from the environment (action.yml maps them), so nothing the user
 * typed is ever spliced into a shell command.
 * @param {Record<string, string | undefined>} env
 * @param {{ log?: (line: string) => void }} [deps]
 */
export async function run(env, deps = {}) {
  const log = deps.log ?? ((/** @type {string} */ l) => process.stdout.write(`${l}\n`));
  const url = (env.INPUT_URL ?? "").trim();
  const failOn = (env.INPUT_FAIL_ON ?? "high").trim();
  const sarifFile = env.INPUT_SARIF_FILE || "gaugeline.sarif";
  if (!url)
    return finish(env, log, { failed: true, message: "The url input is empty.", sarifFile: "" });
  // Fixed messages: what the user typed is never echoed into a workflow command line.
  if (!["high", "medium", "never"].includes(failOn))
    return finish(env, log, {
      failed: true,
      message: "fail-on accepts high, medium or never.",
      sarifFile: "",
    });
  // Tests point GAUGELINE_ACTION_BIN at the built CLI, as a JSON list so a path may hold spaces.
  // Otherwise the release to run is an exact version the user pinned: npx would run a tag, a range,
  // a URL or another package ("npm:other@1") just as readily, and none of them is a release we
  // published. There is no default and no "latest".
  if (!env.GAUGELINE_ACTION_BIN && !EXACT_VERSION.test(env.INPUT_VERSION ?? ""))
    return finish(env, log, { failed: true, message: VERSION_MESSAGE, sarifFile: "" });
  const bin = env.GAUGELINE_ACTION_BIN
    ? /** @type {string[]} */ (JSON.parse(env.GAUGELINE_ACTION_BIN))
    : ["npx", "--yes", `gaugeline@${env.INPUT_VERSION}`];
  // Flags first, then -- and the address, so an address is never read as a flag. No probing flag
  // is ever passed and no input offers one: the action only runs the default, read-only checks.
  const args = [
    ...bin.slice(1),
    "--format",
    "sarif",
    ...(failOn === "never" ? [] : ["--ci"]),
    ...(env.INPUT_ALLOW_PRIVATE === "true" ? ["--allow-private"] : []),
    "--",
    url,
  ];
  /** @type {{ stdout: string, stderr: string, status: number }} */
  const r = await new Promise((resolve) => {
    execFile(
      bin[0] ?? "npx",
      args,
      { encoding: "utf8", env: { ...process.env, ...env }, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) =>
        resolve({
          stdout,
          stderr,
          // execFile reports a non-zero exit as error.code; anything else (no such program) is "could not run".
          status: error ? (typeof error.code === "number" ? error.code : 2) : 0,
        }),
    );
  });
  if (r.stderr) process.stderr.write(r.stderr);
  /** @type {ReturnType<typeof summarise> | undefined} */
  let summary;
  try {
    summary = summarise(r.stdout);
    writeFileSync(sarifFile, r.stdout);
  } catch {
    summary = undefined;
  }
  const verdict = decide({ exit: r.status, failOn, summary });
  return finish(env, log, {
    failed: verdict.fail,
    message: verdict.reason,
    sarifFile: summary ? sarifFile : "",
    summary,
  });
}

/**
 * @param {Record<string, string | undefined>} env
 * @param {(line: string) => void} log
 * @param {{ failed: boolean, message: string, sarifFile: string, summary?: ReturnType<typeof summarise> }} o
 */
function finish(env, log, o) {
  if (env.GITHUB_OUTPUT)
    appendFileSync(
      env.GITHUB_OUTPUT,
      `failed=${o.failed}\nsarif-file=${o.sarifFile}\nhigh=${o.summary?.high ?? 0}\nmedium=${o.summary?.medium ?? 0}\nlow=${o.summary?.low ?? 0}\n`,
    );
  if (o.failed) log(`::error::${o.message}`);
  return { failed: o.failed, message: o.message };
}

if (
  import.meta.url === `file://${process.argv[1]}` ||
  process.argv[1]?.endsWith("gaugeline-action.mjs")
) {
  // The step always ends 0 so the upload step runs; the last step of action.yml fails the job.
  await run(process.env);
}

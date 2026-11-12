// @ts-check
/**
 * The logic of action.yml: run the published CLI, keep its SARIF, decide whether the job fails, and
 * post one pull request comment that later runs edit. Plain Node, no dependencies, so the action
 * runs on any runner with Node and the file is tested as it ships.
 *
 * What it asks of GitHub: list the pull request's comments and write one comment, with the job's
 * own GITHUB_TOKEN, on the repository the job runs in. It never makes a request to the checked
 * site: that is the CLI's job, and the CLI only reads.
 */
import { execFile } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

/** The hidden marker the comment is found by. Never shown: it is an HTML comment. */
export const MARKER = "<!-- gaugeline-action -->";
const LIST_LIMIT = 10;

/** A Markdown table cell: pipes and backslashes escaped, line breaks flattened. */
const cell = (/** @type {string} */ t) =>
  t
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .replace(/\r?\n|\r/g, " ")
    .trim();

/**
 * What the SARIF log says: findings by level (muted ones left out), and the first few as rows.
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
  const order = { error: 0, warning: 1, note: 2 };
  const rows = [...results]
    .sort(
      (/** @type {any} */ a, /** @type {any} */ b) =>
        (order[/** @type {'error'} */ (a.level)] ?? 3) -
        (order[/** @type {'error'} */ (b.level)] ?? 3),
    )
    .slice(0, LIST_LIMIT)
    .map((/** @type {any} */ r) => ({
      level: r.level,
      title: String(r.message?.text ?? "").split("\n")[0] ?? "",
      evidence: String(r.properties?.evidence ?? ""),
    }));
  return {
    high: count("error"),
    medium: count("warning"),
    low: count("note"),
    total: results.length,
    rows,
  };
}

/**
 * The comment body. Deterministic: the same SARIF and inputs give the same text.
 * @param {string} sarifText
 * @param {{ url: string, failOn: string }} opts
 */
export function buildComment(sarifText, opts) {
  const s = summarise(sarifText);
  const label = { error: "Fix this first", warning: "Fix soon", note: "Worth knowing" };
  const lines = [MARKER, `### Gaugeline checked ${cell(opts.url)}`, ""];
  lines.push(
    s.total === 0
      ? "Nothing to look at."
      : `${s.high} to fix first, ${s.medium} to fix soon, ${s.low} worth knowing.`,
  );
  if (s.rows.length > 0) {
    lines.push("", "| Level | Finding | Evidence |", "| --- | --- | --- |");
    for (const r of s.rows)
      lines.push(
        `| ${label[/** @type {'error'} */ (r.level)] ?? r.level} | ${cell(r.title)} | ${cell(r.evidence)} |`,
      );
    if (s.total > s.rows.length)
      lines.push(
        "",
        `...and ${s.total - s.rows.length} more: they are in the SARIF file and in the Security tab.`,
      );
  }
  lines.push(
    "",
    `Fails the job on: ${opts.failOn === "never" ? "nothing" : `"${opts.failOn === "medium" ? "Fix soon" : "Fix this first"}" findings`}. This comment is edited on every run.`,
  );
  return `${lines.join("\n")}\n`;
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
 * Post the comment, or edit the one an earlier run left. Returns what happened; never throws, so a
 * comment problem can not change the check's result.
 * @param {{ body: string, repo: string, pr: number, token: string, api?: string, fetch?: typeof fetch }} a
 */
export async function upsertComment({
  body,
  repo,
  pr,
  token,
  api = "https://api.github.com",
  fetch: f = globalThis.fetch,
}) {
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "content-type": "application/json",
    "x-github-api-version": "2022-11-28",
  };
  try {
    let existing;
    for (let page = 1; page <= 20 && !existing; page++) {
      const res = await f(`${api}/repos/${repo}/issues/${pr}/comments?per_page=100&page=${page}`, {
        headers,
      });
      if (!res.ok) return { done: false, why: `could not list comments (${res.status})` };
      const list = /** @type {{ id: number, body?: string }[]} */ (await res.json());
      existing = list.find((c) => typeof c.body === "string" && c.body.includes(MARKER));
      if (list.length < 100) break;
    }
    const res = existing
      ? await f(`${api}/repos/${repo}/issues/comments/${existing.id}`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ body }),
        })
      : await f(`${api}/repos/${repo}/issues/${pr}/comments`, {
          method: "POST",
          headers,
          body: JSON.stringify({ body }),
        });
    return res.ok
      ? { done: true, why: existing ? "edited the earlier comment" : "posted the comment" }
      : { done: false, why: `GitHub answered ${res.status}` };
  } catch (err) {
    return { done: false, why: err instanceof Error ? err.message : "the request failed" };
  }
}

/**
 * The pull request this run is for, and whether a comment can be written: not on a fork's pull
 * request (its token is read-only), not without a token, not outside a pull request.
 * @param {Record<string, string | undefined>} env
 */
export function commentTarget(env) {
  if (!env.GITHUB_TOKEN) return { ok: false, why: "no token" };
  if (!(env.GITHUB_EVENT_NAME ?? "").startsWith("pull_request"))
    return { ok: false, why: "not a pull request" };
  let event;
  try {
    event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH ?? "", "utf8"));
  } catch {
    return { ok: false, why: "no event payload" };
  }
  const pr = event.pull_request;
  if (!pr || !env.GITHUB_REPOSITORY) return { ok: false, why: "not a pull request" };
  if (
    pr.head?.repo?.fork === true ||
    (pr.head?.repo?.full_name && pr.head.repo.full_name !== env.GITHUB_REPOSITORY)
  )
    return { ok: false, why: "a pull request from a fork has a read-only token" };
  return { ok: true, repo: env.GITHUB_REPOSITORY, pr: Number(pr.number) };
}

/**
 * The whole step. Inputs come from the environment (action.yml maps them), so nothing the user
 * typed is ever spliced into a shell command.
 * @param {Record<string, string | undefined>} env
 * @param {{ log?: (line: string) => void, fetch?: typeof fetch }} [deps]
 */
export async function run(env, deps = {}) {
  const log = deps.log ?? ((/** @type {string} */ l) => process.stdout.write(`${l}\n`));
  const url = (env.INPUT_URL ?? "").trim();
  const failOn = (env.INPUT_FAIL_ON ?? "high").trim();
  const comment = (env.INPUT_COMMENT ?? "true").trim() === "true";
  const sarifFile = env.INPUT_SARIF_FILE || "gaugeline.sarif";
  if (!url)
    return finish(env, log, { failed: true, message: "The url input is empty.", sarifFile });
  if (!["high", "medium", "never"].includes(failOn))
    return finish(env, log, {
      failed: true,
      message: `fail-on accepts high, medium or never, not "${failOn}".`,
      sarifFile,
    });
  // Tests point GAUGELINE_ACTION_BIN at the built CLI, as a JSON list so a path may hold spaces.
  const bin = env.GAUGELINE_ACTION_BIN
    ? /** @type {string[]} */ (JSON.parse(env.GAUGELINE_ACTION_BIN))
    : ["npx", "--yes", `gaugeline@${env.INPUT_VERSION || "latest"}`];
  const args = [
    ...bin.slice(1),
    url,
    "--format",
    "sarif",
    ...(failOn === "never" ? [] : ["--ci"]),
    ...(env.INPUT_ALLOW_PRIVATE === "true" ? ["--allow-private"] : []),
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
  if (summary && comment) {
    const target = commentTarget(env);
    if (!target.ok) log(`::notice::No pull request comment: ${target.why}.`);
    else {
      const res = await upsertComment({
        body: buildComment(r.stdout, { url, failOn }),
        repo: target.repo ?? "",
        pr: target.pr ?? 0,
        token: env.GITHUB_TOKEN ?? "",
        ...(deps.fetch ? { fetch: deps.fetch } : {}),
      });
      if (!res.done) log(`::warning::No pull request comment: ${res.why}.`);
    }
  }
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

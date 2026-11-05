/**
 * Fail a pull request that changes source without a changeset, or changes what users see without a
 * docs change, unless it is labelled "internal".
 *   pnpm pr-gate [--base origin/main]
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { gate, parseChangeset, type GateInput } from "./lib/gate.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

export function collectInput(cwd: string, base: string, eventPath: string | undefined): GateInput {
  const mergeBase = git(cwd, "merge-base", base, "HEAD").trim();
  const lines = git(cwd, "diff", "--name-status", "-M", `${mergeBase}...HEAD`)
    .split("\n")
    .filter(Boolean);
  const files: string[] = [];
  const added: string[] = [];
  const deleted: string[] = [];
  for (const line of lines) {
    const [status = "", ...paths] = line.split("\t");
    files.push(...paths);
    const path = paths.at(-1) ?? "";
    const isChangeset = (p: string) =>
      /^\.changeset\/[^/]+\.md$/.test(p) && !p.endsWith("README.md");
    if ((status.startsWith("A") || status.startsWith("C")) && isChangeset(path)) added.push(path);
    if (status.startsWith("D") && isChangeset(paths[0] ?? "")) deleted.push(paths[0] ?? "");
  }
  let labels: string[] = [];
  if (eventPath && existsSync(eventPath)) {
    const event = JSON.parse(readFileSync(eventPath, "utf8")) as {
      pull_request?: { labels?: { name: string }[] };
    };
    labels = (event.pull_request?.labels ?? []).map((l) => l.name);
  }
  return {
    files,
    changesets: added.map((file) => ({
      file,
      ...parseChangeset(readFileSync(`${cwd}/${file}`, "utf8")),
    })),
    labels,
    deletedChangesets: deleted,
  };
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const i = process.argv.indexOf("--base");
  const base =
    i >= 0
      ? (process.argv[i + 1] ?? "origin/main")
      : `origin/${process.env.GITHUB_BASE_REF || "main"}`;
  const result = gate(collectInput(process.cwd(), base, process.env.GITHUB_EVENT_PATH));
  for (const p of result.problems) process.stderr.write(`pr-gate: ${p}\n`);
  if (!result.ok) process.exitCode = 1;
  else process.stdout.write("pr-gate: ok\n");
}

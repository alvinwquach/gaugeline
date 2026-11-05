/**
 * Run the CLI built from this commit against a site, the way the dogfood workflow does:
 *   pnpm build && pnpm dogfood <address> [--out <dir>] [--allow-private]
 * 1. gaugeline <address> --ci --no-open        its exit code is the result
 * 2. gaugeline <address> --json > findings.json
 * Writes a Markdown summary to GITHUB_STEP_SUMMARY (when set) and to <dir>/summary.md.
 * Exit 2 means the site did not answer, which is not a finding.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { summarise } from "./lib/dogfood.js";

const args = process.argv.slice(2);
const address =
  args.find((a) => !a.startsWith("--") && args[args.indexOf(a) - 1] !== "--out") ?? "";
const outAt = args.indexOf("--out");
const out = outAt >= 0 ? (args[outAt + 1] ?? ".") : ".";
const extra = args.includes("--allow-private") ? ["--allow-private"] : [];
const bin = fileURLToPath(new URL("../packages/cli/dist/index.js", import.meta.url));
if (!address) {
  process.stderr.write("Usage: pnpm dogfood <address> [--out <dir>]\n");
  process.exit(2);
}
mkdirSync(out, { recursive: true });
const env = { ...process.env, NO_COLOR: "1" };
// The address is passed through unchanged, trailing path and query included.
const first = spawnSync(process.execPath, [bin, address, "--ci", "--no-open", ...extra], {
  encoding: "utf8",
  env,
  cwd: out,
});
process.stdout.write(first.stdout);
process.stderr.write(first.stderr);
const code = first.status ?? 2;
if (code === 2) {
  process.stderr.write("The docs site did not answer. This is an outage, not a finding.\n");
  process.exit(2);
}
const json = spawnSync(process.execPath, [bin, address, "--json", "--quiet", ...extra], {
  encoding: "utf8",
  env,
  cwd: out,
});
writeFileSync(join(out, "findings.json"), json.stdout);
const summary = summarise(JSON.parse(json.stdout) as unknown);
writeFileSync(join(out, "summary.md"), summary);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, summary);
process.exit(code);

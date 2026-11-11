/**
 * Run by .github/workflows/regenerate.yml on every push to main: regenerate the generated files and commit
 * them as the github-actions bot. Fails visibly (red job, annotation, step summary) when it cannot; nothing
 * else waits for this job.
 */
import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { runGenAll } from "./lib/gen-all.js";
import { regenerate } from "./lib/regenerate.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = regenerate({ root, generate: (r) => runGenAll(r, { surface: true }) });

let summary: string;
if (out.status === "unchanged") summary = "Generated files already match the sources on main.";
else if (out.status === "pushed")
  summary = `Committed ${out.files.length} regenerated file(s) to main (attempt ${out.attempts}): ${out.files.join(", ")}.`;
else summary = `Could not regenerate (${out.kind}): ${out.reason}`;
process.stdout.write(`${summary}\n`);
if (process.env.GITHUB_STEP_SUMMARY)
  appendFileSync(process.env.GITHUB_STEP_SUMMARY, `### Regenerate generated files\n\n${summary}\n`);
if (out.status === "failed") {
  process.stdout.write(
    `::error title=Regenerate generated files::${summary.replace(/\n/g, " ")}\n`,
  );
  process.exitCode = 1;
}

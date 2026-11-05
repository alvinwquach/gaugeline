/**
 * Fail a pull request whose body cannot be filed: no Changelog, a placeholder, a bad trailer.
 *   pnpm pr:check -- <file with the body>     (local dry run)
 *   In CI the body comes from the pull_request event (GITHUB_EVENT_PATH).
 */
import { existsSync, readFileSync } from "node:fs";
import { parsePr } from "./parse-pr.js";

const file = process.argv.slice(2).find((a) => a !== "--");
const eventPath = process.env.GITHUB_EVENT_PATH;
const body = file
  ? readFileSync(file, "utf8")
  : eventPath && existsSync(eventPath)
    ? ((JSON.parse(readFileSync(eventPath, "utf8")) as { pull_request?: { body?: string | null } })
        .pull_request?.body ?? "")
    : "";
const parsed = parsePr(body);
for (const p of parsed.problems) process.stderr.write(`pr:check: ${p}\n`);
if (parsed.problems.length > 0) process.exitCode = 1;
else
  process.stdout.write(
    `pr:check: ok (${parsed.section}${parsed.changelog ? `: ${parsed.changelog}` : ", no changelog line"})\n`,
  );

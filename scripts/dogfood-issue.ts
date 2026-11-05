/**
 * Nightly only: open, update or close the one self-check issue, with the gh CLI.
 *   pnpm exec tsx scripts/dogfood-issue.ts <exit-code> <summary.md>
 */
import { execFileSync } from "node:child_process";
import { ISSUE_TITLE, issueAction } from "./lib/dogfood.js";

const [codeText = "0", summaryPath = "summary.md"] = process.argv.slice(2);
const gh = (...a: string[]) => execFileSync("gh", a, { encoding: "utf8" });
const open = (
  JSON.parse(
    gh(
      "issue",
      "list",
      "--state",
      "open",
      "--search",
      `"${ISSUE_TITLE}" in:title`,
      "--json",
      "number,title",
    ),
  ) as { number: number; title: string }[]
).find((i) => i.title === ISSUE_TITLE);
const next = issueAction(open, Number(codeText));
if (next.action === "create")
  gh("issue", "create", "--title", ISSUE_TITLE, "--body-file", summaryPath);
if (next.action === "edit") gh("issue", "edit", String(next.number), "--body-file", summaryPath);
if (next.action === "close")
  gh("issue", "close", String(next.number), "--comment", "The latest self-check is clean.");
process.stdout.write(`dogfood-issue: ${next.action}\n`);

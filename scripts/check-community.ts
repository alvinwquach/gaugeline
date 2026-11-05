/** pnpm community:check: issue forms, links in CONTRIBUTING.md and SECURITY.md, and no stray email addresses. */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkForm, checkLinks, findEmails } from "./lib/community.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p: string): string | undefined =>
  existsSync(`${root}${p}`) ? readFileSync(`${root}${p}`, "utf8") : undefined;
const problems: string[] = [];
for (const f of readdirSync(`${root}.github/ISSUE_TEMPLATE`).filter(
  (f) => /\.ya?ml$/.test(f) && f !== "config.yml",
)) {
  problems.push(
    ...checkForm(`.github/ISSUE_TEMPLATE/${f}`, read(`.github/ISSUE_TEMPLATE/${f}`) ?? ""),
  );
}
for (const f of ["CONTRIBUTING.md", "SECURITY.md", "CODE_OF_CONDUCT.md"])
  problems.push(...checkLinks(f, read(f) ?? "", read));
const files = execFileSync("git", ["ls-files", "-co", "--exclude-standard"], {
  cwd: root,
  encoding: "utf8",
})
  .split("\n")
  .filter(
    (f) =>
      f &&
      /\.(ts|js|mjs|cjs|md|json|ya?ml|html|txt|sh)$/.test(f) &&
      f !== "pnpm-lock.yaml" &&
      existsSync(`${root}${f}`),
  );
for (const f of files) problems.push(...findEmails(f, read(f) ?? ""));
for (const p of problems) process.stderr.write(`community:check: ${p}\n`);
if (problems.length > 0) process.exitCode = 1;
else process.stdout.write(`community:check: ok (${files.length} files)\n`);

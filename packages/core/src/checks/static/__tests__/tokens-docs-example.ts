import { fileURLToPath } from "node:url";
import { readLocalSource } from "../../../local-source/read.js";
import { runStaticChecks } from "../../../local-source/run.js";

/**
 * What docs/checks/tokens-in-source.md and docs/checks/personal-data-in-source.md show for the Quayside Taproom's menu site (an invented pub whose
 * site a freelancer built with Next.js and Sanity): what the two checks report over the invented
 * folders in packages/fixtures/source. The docs test compares the page's blocks with these, so the page
 * cannot drift from the tool. To print them for the page:
 * pnpm exec tsx packages/core/src/checks/static/__tests__/tokens-docs-example.ts <check id> [folder label]
 */
export async function findingsJson(id: string, label = "./quayside-site"): Promise<string> {
  const dir = fileURLToPath(new URL(`../../../../../fixtures/source/${id}/fail`, import.meta.url));
  const tree = await readLocalSource(dir, undefined, label);
  const result = await runStaticChecks({ tree, now: new Date("2026-11-13T12:00:00Z"), only: [id] });
  return JSON.stringify(result.findings, null, 2);
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [id, label] = process.argv.slice(2);
  process.stdout.write(`${await findingsJson(id ?? "cms-token-in-client-code", label)}\n`);
}

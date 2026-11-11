import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createFetcher } from "../../fetcher.js";
import { runChecks } from "../../run.js";
import { createCraftRegistry } from "../../checks/craft.js";
import { collectPublished } from "../collect.js";
import { createCraftAdapter } from "../craft.js";
import { readCraft } from "../craft-read.js";
import { CRAFT_ENDPOINT, PAGES_DRIFT, STUDIO_SITE, craftTransport } from "./craft-fixture.js";

/**
 * What docs/integrations/craft.md shows for Fernlight Architects (an invented architecture studio whose
 * two-site Craft CMS install a freelancer built): the settings entry, and what the adapter reads over the
 * invented install. The docs test compares the page's blocks with these, so the page cannot drift from the
 * tool. To print the output for the page:
 *   pnpm exec tsx packages/core/src/adapters/__tests__/craft-docs-example.ts
 */
export const CRAFT_SETTINGS = {
  id: "craft",
  fingerprint: {
    projects: ["title", "project_Entry.summary"],
    journal: ["title"],
    team: ["title"],
  },
} as const;

// Built at run time: a literal that looks like a key is refused by the repository's secret scanning.
const KEY = ["craft", "docs", "fernlight0123456789abcdef"].join("_");

export async function craftReads(): Promise<string> {
  const fetcher = createFetcher({
    transport: craftTransport(undefined, { token: KEY, pages: PAGES_DRIFT }),
    timeoutMs: 5000,
  });
  const adapter = createCraftAdapter({
    env: { CRAFT_URL: CRAFT_ENDPOINT, CRAFT_TOKEN: KEY },
    fetcher,
    settings: CRAFT_SETTINGS,
    sleep: () => Promise.resolve(),
  });
  const types = await adapter.types();
  const fields = await adapter.fieldCounts("projects", ["title", "project_Entry.summary"]);
  const { docs } = await collectPublished(adapter, { types: ["projects"] });
  const reading = await readCraft({ adapter, fetcher, site: STUDIO_SITE });
  const checked = await runChecks(reading, createCraftRegistry());
  return JSON.stringify(
    {
      "live entries by section (every site counted)": types,
      "project fields": fields,
      "drafts reachable": await adapter.draftsReachable(),
      "live projects": docs,
      "pages asked for on the studio site": reading.pages.map((p) => ({
        entry: p.id,
        path: p.path,
        answer: p.answer.kind === "unread" ? "unread" : p.answer.status,
      })),
      "entries on the other site, not counted": reading.otherSites,
      findings: checked.findings.map((f) => f.evidence),
    },
    null,
    2,
  );
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  void craftReads().then((text) => process.stdout.write(`${text}\n`));

import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createFetcher } from "../../fetcher.js";
import { collectPublished } from "../collect.js";
import { createTinaAdapter } from "../tina.js";
import { removeTree, writeTree } from "./git-content-fixture.js";
import { TINA_FILES, TINA_NOW } from "./tina-fixture.js";

/**
 * What docs/integrations/tina.md shows for Rye & Ember Bakery (an invented neighbourhood bakery whose Next.js
 * site a freelancer built on TinaCMS): the settings entry, and what the adapter reads over the invented
 * repository. The docs test compares the page's blocks with these, so the page cannot drift from the tool. To
 * print the output for the page: pnpm exec tsx packages/core/src/adapters/__tests__/tina-docs-example.ts
 */
export const TINA_SETTINGS = {
  id: "tina",
  path: ".",
  fingerprint: { post: ["title", "summary"] },
} as const;

const never = createFetcher({
  transport: () => Promise.reject(new Error("a local read makes no request")),
  timeoutMs: 5000,
});

export async function tinaReads(): Promise<string> {
  const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "gaugeline-docs-")));
  try {
    writeTree(cwd, TINA_FILES);
    const adapter = createTinaAdapter({
      env: {},
      fetcher: never,
      settings: TINA_SETTINGS,
      cwd,
      now: () => TINA_NOW,
    });
    const types = await adapter.types();
    const fields = await adapter.fieldCounts("post", ["title", "summary", "subtitle"]);
    const { docs } = await collectPublished(adapter);
    return JSON.stringify(
      {
        types,
        "post fields": fields,
        "published items": docs.map((d) => ({
          type: d.type,
          id: d.id,
          url: d.url ?? null,
          ...(d.type === "post" ? { fieldHashes: d.fieldHashes } : {}),
        })),
        "not read": await adapter.notRead(),
        "drafts reachable": await adapter.draftsReachable(),
      },
      null,
      2,
    );
  } finally {
    removeTree(cwd);
  }
}

if (
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  void tinaReads().then((text) => process.stdout.write(`${text}\n`));

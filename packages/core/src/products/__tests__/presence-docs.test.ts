import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  PRESENCE_CHECK_IDS,
  createPresenceRegistry,
  presenceInput,
  summarisePresence,
} from "../../checks/product-presence.js";
import { runChecks, type RunResult } from "../../run.js";
import { readSurfStore, type Down } from "./presence-store.js";

const page = readFileSync(
  fileURLToPath(new URL("../../../../../docs/products-and-prices.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

const block = (title: string): string | undefined =>
  new RegExp(`\`\`\`json title=${title}\\n([\\s\\S]*?)\\n\`\`\``).exec(page)?.[1];

async function check(down: readonly Down[]): Promise<{ r: RunResult; summary: string[] }> {
  const store = await readSurfStore(down);
  const input = presenceInput(store.match, store);
  return { r: await runChecks(input, createPresenceRegistry()), summary: summarisePresence(input) };
}

describe("docs/products-and-prices.md: Missing, archived and orphaned products", () => {
  it("the Presence findings block is what the six checks return for the surf club's cassettes", async () => {
    const { r, summary } = await check([]);
    const shown = {
      findings: r.findings.map((f) => ({
        check: f.checkId,
        level: f.severity,
        product: f.url,
        evidence: f.evidence,
      })),
      summary,
    };
    expect(block("Presence findings")).toBe(JSON.stringify(shown, null, 2));
  });

  it("the Printful-unreachable block keeps the Stripe findings and says Printful was not read", async () => {
    const { r, summary } = await check(["printful"]);
    const shown = { checks: r.findings.map((f) => f.checkId), summary };
    expect(block("Presence findings with Printful unreachable")).toBe(
      JSON.stringify(shown, null, 2),
    );
  });

  it("the page names every check id, the freelancer's client and the rule for a missing connector", () => {
    const section =
      /## Missing, archived and orphaned products\n([\s\S]*?)\n## Subscription plans/.exec(
        page,
      )?.[1];
    expect(section).toBeDefined();
    for (const id of PRESENCE_CHECK_IDS) expect(section).toContain(`\`${id}\``);
    expect(section).toContain("Lowtide Surf Club");
    expect(section).toContain("never reports a product as missing because a connector failed");
  });
});

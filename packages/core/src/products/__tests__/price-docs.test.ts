import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PRICE_CHECK_IDS, createPriceRegistry } from "../../checks/prices.js";
import { runChecks, type RunResult } from "../../run.js";
import { readSupperStore } from "./price-store.js";

const page = readFileSync(
  fileURLToPath(new URL("../../../../../docs/products-and-prices.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

/** The result as the docs page shows it: the level, the product and the evidence; no ids of runs. */
export function describePrices(r: RunResult) {
  return {
    findings: r.findings.map((f) => ({
      check: f.checkId,
      level: f.severity,
      product: f.url,
      evidence: f.evidence,
    })),
    notices: r.couldNotCheck.map((c) => ({ check: c.id, reason: c.reason })),
  };
}

export async function checkSupperStore(): Promise<RunResult> {
  const store = await readSupperStore();
  return runChecks({ groups: store.match.groups }, createPriceRegistry());
}

describe("docs/products-and-prices.md: Price checks", () => {
  it("the Price findings block is what the four checks return for the supper club's cassettes", async () => {
    const shown = /```json title=Price findings\n([\s\S]*?)\n```/.exec(page)?.[1];
    expect(shown).toBe(JSON.stringify(describePrices(await checkSupperStore()), null, 2));
  });

  it("the page names every check id and the freelancer's client", () => {
    const section = /## Price checks\n([\s\S]*?)\n## What it can't decide for you/.exec(page)?.[1];
    expect(section).toBeDefined();
    for (const id of PRICE_CHECK_IDS) expect(section).toContain(`\`${id}\``);
    expect(section).toContain("Ember Supper Club");
  });

  it("the page says Gaugeline never names the right system", () => {
    expect(page).toContain("Gaugeline never says which one is right");
  });
});

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SUBSCRIPTION_CHECK_IDS, createSubscriptionRegistry } from "../../checks/plans.js";
import { runChecks, type RunResult } from "../../run.js";
import { HARBOR_CONFIG, HARBOR_PAGE, readHarbor } from "./plan-store.js";

const page = readFileSync(
  fileURLToPath(new URL("../../../../../docs/products-and-prices.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

const block = (title: string, lang: string): string | undefined =>
  new RegExp(`\`\`\`${lang} title=${title}\\n([\\s\\S]*?)\\n\`\`\``).exec(page)?.[1];

/** The result as the docs page shows it: the check, the level, the address and the evidence. */
export function describePlans(r: RunResult) {
  return {
    findings: r.findings.map((f) => ({
      check: f.checkId,
      level: f.severity,
      page: f.url,
      evidence: f.evidence,
    })),
    notices: r.couldNotCheck.map((c) => ({ check: c.id, reason: c.reason })),
  };
}

export async function checkHarbor(): Promise<RunResult> {
  const { plans, stripe } = await readHarbor();
  return runChecks(
    { plans, stripe, products: HARBOR_CONFIG.products ?? [] },
    createSubscriptionRegistry(),
  );
}

describe("docs/products-and-prices.md: Subscription plans", () => {
  it("the configuration block is the one the studio's tests use", () => {
    expect(JSON.parse(block("gaugeline.plans.json", "json") ?? "null")).toEqual(HARBOR_CONFIG);
  });

  it("the page block is the studio's membership page", () => {
    expect(block("Membership page", "html")).toBe(HARBOR_PAGE);
  });

  it("the Plan findings block is what the five checks return for the studio", async () => {
    expect(block("Plan findings", "json")).toBe(
      JSON.stringify(describePlans(await checkHarbor()), null, 2),
    );
  });

  it("names every check id and the freelancer's client", () => {
    const section = /## Subscription plans\n([\s\S]*?)\n## How keys are handled/.exec(page)?.[1];
    expect(section).toBeDefined();
    for (const id of SUBSCRIPTION_CHECK_IDS) expect(section).toContain(`\`${id}\``);
    expect(section).toContain("Harbor Street Yoga");
    expect(section).toContain("Gaugeline never says which one is right");
  });
});

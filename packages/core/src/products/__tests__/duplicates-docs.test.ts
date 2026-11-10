import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { DUPLICATE_CHECK_IDS, createDuplicatesRegistry } from "../../checks/product-duplicates.js";
import { runChecks } from "../../run.js";
import { bakehouseStore } from "./duplicate-store.js";

const page = readFileSync(
  fileURLToPath(new URL("../../../../../docs/products-and-prices.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

const block = (title: string): string | undefined =>
  new RegExp(`\`\`\`json title=${title}\\n([\\s\\S]*?)\\n\`\`\``).exec(page)?.[1];

describe("docs/products-and-prices.md: Duplicates inside one system", () => {
  it("the Duplicate findings block is what the three checks return for the bakery's records", async () => {
    const r = await runChecks(bakehouseStore(), createDuplicatesRegistry());
    const shown = {
      findings: r.findings.map((f) => ({
        check: f.checkId,
        level: f.severity,
        product: f.url,
        evidence: f.evidence,
      })),
    };
    expect(block("Duplicate findings")).toBe(JSON.stringify(shown, null, 2));
  });

  it("the section names every check id, the freelancer's client and why duplicates come first", () => {
    const section = /## Duplicates inside one system\n([\s\S]*?)\n## How products are matched/.exec(
      page,
    )?.[1];
    expect(section).toBeDefined();
    for (const id of DUPLICATE_CHECK_IDS) expect(section).toContain(`\`${id}\``);
    expect(section).toContain("Marigold Bakehouse");
    expect(section).toContain("reported first");
    expect(section).toContain("Gaugeline does not choose");
  });
});

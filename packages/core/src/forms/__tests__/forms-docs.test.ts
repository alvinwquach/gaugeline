import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Hop } from "../../fetcher.js";
import { crmInsecure } from "../../checks/crm-insecure.js";
import { crmNoCampaignFields } from "../../checks/crm-no-campaign-fields.js";
import { PAGE_CHECKS } from "../../checks/index.js";
import { buildSnapshot } from "../../snapshot.js";
import { FORM_PROVIDER_IDS, PROVIDERS, detectForms, formNotes } from "../providers.js";

const page = readFileSync(
  fileURLToPath(new URL("../../../../../docs/forms-and-crm.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

const block = (lang: string, title: string): string | undefined =>
  new RegExp(`\`\`\`${lang} title=${title}\\n([\\s\\S]*?)\\n\`\`\``).exec(page)?.[1];

describe("docs/forms-and-crm.md: Which providers Gaugeline recognizes", () => {
  it("the Booking page sightings block is what detection returns for the page above it", () => {
    const html = block("html", "Booking page");
    expect(html).toBeDefined();
    const hops: Hop[] = [
      {
        url: "https://harbour-physio.example/book/",
        status: 200,
        headers: { "content-type": "text/html" },
        body: html,
        ms: 1,
      },
    ];
    const s = buildSnapshot(hops);
    const shown = { sightings: detectForms(s), notes: formNotes(s) };
    expect(block("json", "Booking page sightings")).toBe(JSON.stringify(shown, null, 2));
  });

  it("the table names every provider by its label, and the page states each rule of evidence", () => {
    const section = /## Which providers Gaugeline recognizes\n([\s\S]*?)\n### Example/.exec(
      page,
    )?.[1];
    expect(section).toBeDefined();
    expect(PROVIDERS).toHaveLength(FORM_PROVIDER_IDS.length);
    for (const p of PROVIDERS) expect(section).toContain(p.label);
    expect(section).toContain("label boundary");
    expect(section).toContain("forms may be added by JavaScript");
    expect(section).toContain("never submits a form");
  });
});

describe("docs/forms-and-crm.md: the checks", () => {
  it("the Enquiry form findings are what the checks return for the form above them", async () => {
    const html = block("html", "Enquiry form");
    expect(html).toBeDefined();
    const hops: Hop[] = [
      {
        url: "https://tideline-coaching.example/enquire/",
        status: 200,
        headers: { "content-type": "text/html" },
        body: html,
        ms: 1,
      },
    ];
    const s = buildSnapshot(hops);
    const ctx = { warn: () => undefined };
    const lines: string[] = [];
    for (const check of [crmInsecure, crmNoCampaignFields]) {
      for (const f of await check.run(s, ctx)) lines.push(`${f.checkId}: ${f.evidence}`);
    }
    expect(block("text", "Enquiry form findings")).toBe(lines.join("\n"));
  });

  it("the page names every id of the six checks and says what it cannot see", () => {
    const ids = [
      "crm-no-tracking",
      "crm-late-tracking",
      "crm-insecure",
      "crm-no-campaign-fields",
      "forms-many-providers",
      "mailto-cta",
    ];
    for (const id of ids) {
      expect(page).toContain(`\`${id}\``);
      expect(PAGE_CHECKS.some((c) => c.id === id)).toBe(true);
    }
    expect(page).toContain("## What it cannot see");
    expect(page).toContain("could not see inside the embedded form");
    expect(page).toContain("needs a read-only login");
  });
});

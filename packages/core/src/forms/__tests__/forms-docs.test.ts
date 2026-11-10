import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Hop } from "../../fetcher.js";
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

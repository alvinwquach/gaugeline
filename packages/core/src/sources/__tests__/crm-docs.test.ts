import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SITES_DIR } from "../../../../fixtures/src/index.js";
import { replayMcp, staticSite } from "../../../../testkit/src/index.js";
import { CRM_CHECKS } from "../../presets.js";
import { createFetcher } from "../../fetcher.js";
import { checkSite } from "../../site.js";
import { crmConfigSchema } from "../crm.js";
import { SALESFORCE_READ_ONLY_URL } from "../salesforce-mcp.js";

const page = readFileSync(
  fileURLToPath(new URL("../../../../../docs/sources/salesforce-mcp.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

const block = (lang: string, title: string): string | undefined =>
  new RegExp(`\`\`\`${lang} title=${title}\\n([\\s\\S]*?)\\n\`\`\``).exec(page)?.[1];

describe("docs/sources/salesforce-mcp.md", () => {
  it("the Tideline findings are what the checks return for the recorded responses", async () => {
    const { result } = await checkSite({
      address: "https://tideline-coaching.example/",
      fetcher: createFetcher({
        transport: staticSite("tideline-coaching.example", `${SITES_DIR}crm-leads`, () =>
          Promise.reject(new Error("unexpected request")),
        ),
        timeoutMs: 5000,
      }),
      only: [...CRM_CHECKS],
      now: () => new Date("2026-11-10T18:00:00Z"),
      crm: {
        config: crmConfigSchema.parse({ salesforce: {} }),
        transport: replayMcp("tideline-leads"),
      },
    });
    const lines = result.findings.map((f) => `${f.checkId}: ${f.evidence}`);
    expect(block("text", "Tideline findings")).toBe(lines.join("\n"));
  });

  it("the file example is accepted by the schema, and the default server is the one the page names", () => {
    const json = JSON.parse(block("json", "gaugeline.crm.json") ?? "null") as unknown;
    expect(crmConfigSchema.safeParse(json).success).toBe(true);
    expect(page).toContain(SALESFORCE_READ_ONLY_URL);
  });

  it("names every check, the request limit, the one env variable and what is uncited", () => {
    for (const id of CRM_CHECKS) expect(page).toContain(`\`${id}\``);
    expect(page).toContain("At most **8 requests**");
    expect(page).toContain("`SALESFORCE_MCP_ACCESS_TOKEN`");
    expect(page).toContain("**uncited**");
    expect(page).toContain("cannot connect on its own yet");
  });
});

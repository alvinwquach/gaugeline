import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { publishedNotLive } from "../../checks/published-not-live.js";
import { barSite, context, fakeCms, homePage, reader } from "./world.js";

/**
 * docs/guides/published-not-live.md quotes one finding for the bar's autumn menu. This test builds the same
 * scenario (invented content, a fixed clock) and compares the quoted line with what the check reports.
 */
const page = readFileSync(
  fileURLToPath(new URL("../../../../../docs/guides/published-not-live.md", import.meta.url)),
  "utf8",
).replace(/\r\n/g, "\n");

describe("docs/guides/published-not-live.md", () => {
  it("quotes the evidence the check really reports for the autumn menu", async () => {
    const { fetcher } = barSite({
      "/menu/autumn-cocktails": {
        status: 200,
        title: "Summer cocktails",
        headers: { age: "3540", "cache-control": "s-maxage=31536000", "x-vercel-cache": "HIT" },
      },
    });
    const cms = fakeCms([{ slug: "autumn-cocktails", title: "Autumn cocktails", minutesAgo: 62 }]);
    const { ctx } = context(reader([cms], fetcher));
    const found = await publishedNotLive.run(homePage(), ctx);
    expect(found).toHaveLength(1);
    const quoted = /```text title="Finding: published-not-live \(high\)"\n([^\n]+)\n```/.exec(
      page,
    )?.[1];
    expect(quoted).toBe(found[0]?.evidence);
  });

  it("shows the settings it describes and names its checks", () => {
    expect(page).toContain('"live": { "days": 7, "graceMinutes": 15, "maxPages": 40');
    for (const id of ["published-not-live", "live-page-missing", "unpublished-still-live"])
      expect(page).toContain(`\`${id}\``);
  });
});

import type { AdsEngine } from "@gaugeline/app-server";
import {
  buildResult,
  groupByDestination,
  readAdsExport,
  spendByCurrency,
  type AdsExport,
  type Destination,
} from "@gaugeline/core";

/** An export, read and grouped by landing page. What `read` hands to `check`. */
export interface ParsedAds {
  export: AdsExport;
  groups: Map<string, Destination>;
}

/**
 * The ads command, as the app uses it. `gaugeline ads` and `gaugeline open --ads` both go through
 * this one engine, so the app shows exactly what the command prints and has no second reader.
 *
 * Reading and grouping an export is packages/core (readAdsExport, groupByDestination). The checks
 * on the pages it names arrive in G24a and G24b; until then the result has no findings and no
 * request is sent. When they land they go in `check`, and `read`, the app and the CLI are unchanged.
 */
export const adsEngine: AdsEngine<ParsedAds> = {
  read(csvText) {
    const read = readAdsExport(csvText);
    return { export: read, groups: groupByDestination(read.rows) };
  },
  check(parsed, ctx) {
    const { rows, warnings } = parsed.export;
    const pages = parsed.groups.size;
    ctx.onProgress(
      `Read ${rows.length} ${rows.length === 1 ? "ad" : "ads"} that go to ${pages} landing ${pages === 1 ? "page" : "pages"}`,
    );
    for (const w of warnings) ctx.onProgress(w);
    return Promise.resolve({
      result: buildResult({
        url: "ads-export",
        startedAt: ctx.now,
        findings: [],
        passed: [],
        failed: [],
        couldNotCheck: [],
        sampled: {},
      }),
      ads: { currencies: spendByCurrency(parsed.groups) },
    });
  },
};

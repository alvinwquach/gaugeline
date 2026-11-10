import type { AdsEngine } from "@gaugeline/app-server";
import {
  buildResult,
  checkAdLandingPages,
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
 * on the pages it names (checkAdLandingPages) ask each landing page once through the run's fetcher.
 * G24a puts the campaign tag check there; G24b adds its checks beside it, and `read`, the app and
 * the command are unchanged.
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
    ctx.onProgress(
      `Following the campaign tags through ${pages} landing ${pages === 1 ? "page" : "pages"}`,
    );
    return checkAdLandingPages(parsed.groups, { fetcher: ctx.fetcher }).then((checked) => ({
      result: buildResult({
        url: "ads-export",
        startedAt: ctx.now,
        findings: checked.findings,
        passed: checked.passed,
        failed: checked.failed,
        couldNotCheck: checked.couldNotCheck,
        sampled: {},
      }),
      ads: { currencies: spendByCurrency(parsed.groups) },
    }));
  },
};

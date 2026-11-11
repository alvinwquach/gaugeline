import { describe, expect, it } from "vitest";
import { copyrightStale } from "../copyright-stale.js";
import { URL0, ctx, page } from "./helpers.js";

describe("copyright-stale", () => {
  it("passes on a page without the problem", async () => {
    expect(await copyrightStale.run(page(), ctx)).toEqual([]);
  });

  it("fails on a page with it, with the exact evidence", async () => {
    expect(
      await copyrightStale.run(page({ title: "Failing page for copyright-stale" }), ctx),
    ).toEqual([
      {
        checkId: "copyright-stale",
        severity: "low",
        title: "The footer copyright year is out of date",
        evidence: 'title is "Failing page for copyright-stale" on ' + URL0,
        url: URL0,
      },
    ]);
  });
});

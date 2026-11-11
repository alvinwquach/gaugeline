import { describe, expect, it } from "vitest";
import { copyDatePassed } from "../copy-date-passed.js";
import { URL0, ctx, page } from "./helpers.js";

describe("copy-date-passed", () => {
  it("passes on a page without the problem", async () => {
    expect(await copyDatePassed.run(page(), ctx)).toEqual([]);
  });

  it("fails on a page with it, with the exact evidence", async () => {
    expect(
      await copyDatePassed.run(page({ title: "Failing page for copy-date-passed" }), ctx),
    ).toEqual([
      {
        checkId: "copy-date-passed",
        severity: "medium",
        title: "A promotion or notice on the page has a date that has already passed",
        evidence: 'title is "Failing page for copy-date-passed" on ' + URL0,
        url: URL0,
      },
    ]);
  });
});

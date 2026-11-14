import { SITES_DIR, startFixture, type Fixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { runBin } from "./helpers/bin.js";

/**
 * events-tab-order (NAV-09), through the built bin: Larkspur Flowers is an invented florist whose menu gives one
 * link a positive tabindex. The positive tabindex is read from the page as sent, so it is found with no
 * browser; the parts that need one (the phone, the Tab key) say could not check, never a pass.
 */
const sites: Fixture[] = [];
afterEach(async () => {
  await Promise.all(sites.splice(0).map((s) => s.close()));
});
const flags = (s: Fixture) => [s.origin, "--allow-private", "--no-open", "--json"];

describe("events-tab-order and events-parity: end to end, no browser", () => {
  it("names the positive tabindex, and says the phone and the keyboard could not be checked", async () => {
    const site = await startFixture("nav-tab-order");
    sites.push(site);
    const r = await runBin(flags(site), {}, { cwd: `${SITES_DIR}nav-tab-order` });
    const result = JSON.parse(r.stdout) as {
      findings: { checkId: string; evidence: string }[];
      couldNotCheck: { id: string; reason: string }[];
      passed: string[];
    };
    expect(
      result.findings
        .filter((f) => f.checkId.startsWith("events-"))
        .map((f) => [f.checkId, f.evidence]),
    ).toEqual([
      [
        "events-tab-order",
        `1 of the plan's links has a positive tabindex, which puts it ahead of every link without one: "Weddings" (/weddings) has tabindex="2"`,
      ],
    ]);
    const unchecked = result.couldNotCheck
      .map((c) => c.id)
      .filter((id) => id.startsWith("events-"));
    expect(unchecked).toEqual([
      "events-distinct",
      "events-fire",
      "events-parity",
      "events-tab-order",
      "events-unlisted",
    ]);
    // Never a pass without a browser.
    expect(result.passed.filter((id) => id.startsWith("events-"))).toEqual([]);
  });

  it("asks for nothing beyond the page: only GET and HEAD, and no analytics address", async () => {
    const site = await startFixture("nav-tab-order");
    sites.push(site);
    await runBin(flags(site), {}, { cwd: `${SITES_DIR}nav-tab-order` });
    expect(site.requests.every((q) => q.method === "GET" || q.method === "HEAD")).toBe(true);
    expect(site.requests.some((q) => /collect|analytics|gtm/.test(q.path ?? ""))).toBe(false);
  });
});

import { startFixture, type Fixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { runBin } from "./helpers/bin.js";

/**
 * nav-link-not-200 (NAV-02), through the built bin: Marlow Vets is an invented practice whose menu
 * has a two-redirect chain, a loop, a 204 and a 404 beside a link that is fine.
 */
const sites: Fixture[] = [];
afterEach(async () => {
  await Promise.all(sites.splice(0).map((s) => s.close()));
});

describe("nav-link-not-200: end to end", () => {
  it("reports the loop, the chain with its hop count and the 204, and leaves the 404 to broken-links", async () => {
    const site = await startFixture("nav-chain");
    sites.push(site);
    const r = await runBin([site.origin, "--allow-private", "--no-open"]);
    expect(r.stdout).toContain("Menu links don't answer 200 at once");
    expect(r.stdout).toContain(
      "header › Services takes 2 redirects (301 /services, 302 /our-services, 200 /care)",
    );
    expect(r.stdout).toContain("header › Vaccinations redirects in a loop");
    expect(r.stdout).toContain("header › Newsletter answers 204, not 200");
    expect(r.stdout).toContain("Links on this page go nowhere");
    expect(r.stdout).not.toContain("Our rooms answers 404");
    expect(r.stdout).not.toContain("header › Pricing");
  });

  it("asks each menu destination once as the link sample did: HEAD or GET only, no address twice", async () => {
    const site = await startFixture("nav-chain");
    sites.push(site);
    await runBin([site.origin, "--allow-private", "--no-open"]);
    expect(site.requests.every((q) => q.method === "GET" || q.method === "HEAD")).toBe(true);
    // The plain request for the menu is the sample's: one HEAD of /pricing for it, plus the one
    // with the test campaign tags (the fixture log has no query, so two in all).
    expect(site.requests.filter((q) => q.method === "HEAD" && q.path === "/pricing")).toHaveLength(
      2,
    );
  });
});

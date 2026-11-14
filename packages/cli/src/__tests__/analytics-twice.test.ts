import { startFixture, type Fixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { runBin } from "./helpers/bin.js";

/**
 * analytics-loaded-twice (NAV-07), through the built bin: Tidewater Yoga is an invented studio that
 * pasted its Tag Manager snippet twice and configures its GA4 id twice.
 */
const sites: Fixture[] = [];
afterEach(async () => {
  await Promise.all(sites.splice(0).map((s) => s.close()));
});

describe("analytics-loaded-twice: end to end", () => {
  it("names the container installed twice and the id configured twice", async () => {
    const site = await startFixture("analytics-twice");
    sites.push(site);
    const r = await runBin([site.origin, "--allow-private", "--no-open"]);
    expect(r.stdout).toContain("Analytics are loaded twice on this page");
    expect(r.stdout).toContain(
      "Tag Manager container GTM-TW1D3R4 is installed 2 times on this page, so every tag in it can fire twice",
    );
    expect(r.stdout).toContain(
      "Google Analytics 4 id G-TIDE000001 is configured 2 times, so each page view is sent twice",
    );
    expect(r.stdout).not.toContain("loaded by gtag.js");
  });

  it("reads the page only: no request goes to Google, and only GET or HEAD is sent", async () => {
    const site = await startFixture("analytics-twice");
    sites.push(site);
    await runBin([site.origin, "--allow-private", "--no-open"]);
    expect(site.requests.every((q) => q.method === "GET" || q.method === "HEAD")).toBe(true);
    expect(site.requests.every((q) => !q.host.includes("google"))).toBe(true);
  });
});

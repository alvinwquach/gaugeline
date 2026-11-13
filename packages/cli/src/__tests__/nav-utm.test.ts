import { PROBING_CHECKS, createPageRegistry } from "@gaugeline/core";
import { SITES_DIR, startFixture, type Fixture } from "@gaugeline/fixtures";
import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { runBin } from "./helpers/bin.js";

/**
 * nav-utm-lost (NAV-01), through the built bin: The Lantern Bar is an invented neighbourhood bar.
 * Its "What's on" menu link redirects to /events and drops the test tags; "Private hire" redirects
 * with the tags kept; the rest answer 200 with no redirect.
 */
const sites: Fixture[] = [];
afterEach(async () => {
  await Promise.all(sites.splice(0).map((s) => s.close()));
});
const flags = (site: Fixture) => [site.origin, "--allow-private", "--no-open"];

describe("nav-utm-lost: end to end", () => {
  it("names the menu link whose redirect drops the tags, and only that one", async () => {
    const site = await startFixture("nav-utm");
    sites.push(site);
    const r = await runBin(flags(site));
    expect(r.stdout).toContain("A menu link drops campaign tags");
    expect(r.stdout).toContain(
      "1 of 6 menu links lose campaign tags: header › What's on: the 301 at hop 1 from /whats-on to /events drops utm_source, utm_medium, utm_campaign",
    );
    expect(r.stdout).toContain("Gaugeline's own test values were used");
    expect(r.stdout).not.toContain("header › Private hire");
  });

  it("asks each menu destination once with HEAD, and never with a method that changes anything", async () => {
    const site = await startFixture("nav-utm");
    sites.push(site);
    await runBin(flags(site));
    const heads = site.requests.filter((q) => q.method === "HEAD").map((q) => q.path);
    for (const path of ["/menu", "/whats-on", "/private-hire", "/about", "/privacy"])
      expect(heads).toContain(path);
    expect(site.requests.every((q) => q.method === "GET" || q.method === "HEAD")).toBe(true);
  });

  it("is a default check, not a probing one: it asks only addresses the page itself links to", () => {
    expect(PROBING_CHECKS).not.toContain("nav-utm-lost");
    expect(
      createPageRegistry()
        .all()
        .map((c) => c.id),
    ).toContain("nav-utm-lost");
  });

  it("the fixture stays invented: reserved or local addresses only", () => {
    const text = readFileSync(`${SITES_DIR}nav-utm/index.html`, "utf8");
    expect(text).not.toMatch(/https?:\/\/(?!\{\{origin\}\})/);
  });
});

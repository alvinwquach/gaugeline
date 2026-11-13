import { startFixture, type Fixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { runBin } from "./helpers/bin.js";

/**
 * nav-link-no-name (NAV-03), through the built bin: Millrace Physio is an invented clinic whose
 * header has an unlabelled envelope icon and a phone icon hidden from assistive tech, and whose
 * footer has an image link with empty alt text. The labelled icon is not reported.
 */
const sites: Fixture[] = [];
afterEach(async () => {
  await Promise.all(sites.splice(0).map((s) => s.close()));
});

describe("nav-link-no-name: end to end", () => {
  it("names the three links with no name and not the labelled icon", async () => {
    const site = await startFixture("nav-names");
    sites.push(site);
    const r = await runBin([site.origin, "--allow-private", "--no-open"]);
    expect(r.stdout).toContain("Some menu links have no name");
    expect(r.stdout).toContain(
      "3 links have no accessible name: header link to /contact, header link to tel:+15550100, footer link to /book",
    );
  });

  it("is read from the page already fetched: the run asks only GET or HEAD", async () => {
    const site = await startFixture("nav-names");
    sites.push(site);
    await runBin([site.origin, "--allow-private", "--no-open"]);
    expect(site.requests.every((q) => q.method === "GET" || q.method === "HEAD")).toBe(true);
  });
});

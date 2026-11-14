import { startFixture, type Fixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { runBin } from "./helpers/bin.js";

/**
 * `--pagespeed` through the built bin, over an invented site on this computer (loopback, --allow-private for
 * the test only): Google reads only public pages, so nothing is sent and both checks say could not check.
 */
const sites: Fixture[] = [];
afterEach(async () => {
  await Promise.all(sites.splice(0).map((s) => s.close()));
});

type Out = {
  findings: { checkId: string }[];
  couldNotCheck: { id: string; reason: string }[];
};

describe("--pagespeed: end to end, the built bin", () => {
  it("sends nothing for a page on this computer and says so for the field check", async () => {
    const site = await startFixture("quick-start");
    sites.push(site);
    const r = await runBin([site.origin, "--pagespeed", "--allow-private", "--no-open", "--json"]);
    expect(r.stderr).not.toContain("Unknown option");
    const out = JSON.parse(r.stdout) as Out;
    expect(out.findings.filter((f) => f.checkId.startsWith("pagespeed-"))).toEqual([]);
    const notes = out.couldNotCheck.filter((c) => c.id === "pagespeed-field-vitals");
    expect(notes.length).toBeGreaterThan(0);
    expect(notes[0]?.reason).toContain("not sent to Google");
    // The fixture saw GET and HEAD only, and Google was never contacted (the site is the only host asked).
    expect(site.requests.every((q) => q.method === "GET" || q.method === "HEAD")).toBe(true);
  });

  it("prints the notice about page addresses and is off without the flag", async () => {
    const site = await startFixture("quick-start");
    sites.push(site);
    const on = await runBin([site.origin, "--pagespeed", "--allow-private", "--no-open", "--json"]);
    expect(on.stderr).toContain("sends the address of each page it reads");
    const off = await runBin([site.origin, "--allow-private", "--no-open", "--json"]);
    expect(off.stderr).not.toContain("PageSpeed");
    const out = JSON.parse(off.stdout) as Out;
    expect(out.couldNotCheck.some((c) => c.id.startsWith("pagespeed-"))).toBe(false);
  });
});

import { startFixture, type Fixture } from "@gaugeline/fixtures";
import { afterEach, describe, expect, it } from "vitest";
import { runBin } from "./helpers/bin.js";

/**
 * form-redirect-leaks-details, through the built bin: Harbour Physio is an invented clinic whose booking form's
 * action holds an email address and whose call-back form sends visitors to an address holding a phone number.
 * The run prints the parameter and a mask, never the value, and asks only by GET or HEAD.
 */
const sites: Fixture[] = [];
afterEach(async () => {
  await Promise.all(sites.splice(0).map((s) => s.close()));
});

type Out = {
  findings: { checkId: string; severity: string; evidence: string }[];
  couldNotCheck: { id: string; reason: string }[];
};

describe("form-redirect-leaks-details: end to end", () => {
  it("finds both leaks, masks them, and says what it could not read", async () => {
    const site = await startFixture("form-redirect-leaks");
    sites.push(site);
    const r = await runBin([site.origin, "--allow-private", "--no-open", "--json"]);
    const out = JSON.parse(r.stdout) as Out;
    const mine = out.findings.filter((f) => f.checkId === "form-redirect-leaks-details");
    expect(mine.map((f) => [f.severity, f.evidence.replace(site.origin, "<origin>")])).toEqual([
      [
        "medium",
        'Form action <origin>/thanks?name=***&email=***: the "email" parameter holds an email address.',
      ],
      [
        "medium",
        'The "retURL" field sends visitors to <origin>/thanks?tel=***: the "tel" parameter holds a phone number.',
      ],
    ]);
    expect(out.couldNotCheck.filter((n) => n.id === "form-redirect-leaks-details")).toHaveLength(1);
    for (const secret of ["sam.reeves", "%40harbour", "%2B1%20555"])
      expect(r.stdout, secret).not.toContain(secret);
    expect(site.requests.every((q) => q.method === "GET" || q.method === "HEAD")).toBe(true);
    expect(site.requests.filter((q) => q.path.startsWith("/thanks"))).toEqual([]);
  });

  it("prints the finding in the terminal too, with its mask", async () => {
    const site = await startFixture("form-redirect-leaks");
    sites.push(site);
    const r = await runBin([site.origin, "--allow-private", "--no-open"], { NO_COLOR: "1" });
    expect(r.stdout).toContain("! A form's thank-you address carries an email or phone number");
    expect(r.stdout).toContain("email=***");
    expect(r.stdout).not.toContain("sam.reeves");
  });
});

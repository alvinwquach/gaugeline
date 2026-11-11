import { describe, expect, it } from "vitest";
import { HANDOFF_CHECKS } from "../../checks/handoff.js";
import { createFetcher } from "../../fetcher.js";
import { createRenewals } from "../../renewals/reader.js";
import { checkSite } from "../../site.js";
import { handoffConfigSchema } from "../config.js";
import { createHandoff } from "../reader.js";
import { createHandoffRegistry } from "../registry.js";
import { BAR_HANDOFF, CLIENT, COACH, COACH_HANDOFF, ENV, FREELANCER, NOW, world } from "./world.js";

async function run(
  address: string,
  config: unknown,
  opts: {
    over?: Parameters<typeof world>[0];
    env?: Record<string, string | undefined>;
    googleLocation?: string;
  } = {},
) {
  const { transport, seen } = world(opts.over);
  const fetcher = createFetcher({ transport });
  const renewals = createRenewals({ config: {}, env: {} }, fetcher);
  const handoff = createHandoff(
    {
      config: handoffConfigSchema.parse(config),
      env: opts.env ?? ENV,
      ...(opts.googleLocation ? { googleLocation: opts.googleLocation } : {}),
    },
    fetcher,
    renewals,
  );
  const checked = await checkSite({
    address,
    fetcher,
    registry: createHandoffRegistry(),
    only: HANDOFF_CHECKS.map((c) => c.id),
    handoff,
    tolerateUnreachable: true,
    now: () => NOW,
  });
  return { ...checked, handoff, seen };
}

describe("gaugeline handoff over recorded responses", () => {
  it("a project where the freelancer is the only admin on Vercel and Sanity: two systems, two findings each", async () => {
    const { result } = await run("marlowe-bar.com", BAR_HANDOFF, {
      googleLocation: "locations/1234567890",
    });
    expect(
      result.findings
        .map((f) => [f.checkId, f.severity, f.url])
        .sort((a, b) => (a.join() < b.join() ? -1 : 1)),
    ).toEqual([
      ["client-not-admin", "high", "handoff:sanity"],
      ["client-not-admin", "high", "handoff:vercel"],
      ["single-admin", "medium", "handoff:sanity"],
      ["single-admin", "medium", "handoff:vercel"],
    ]);
    // The owner is the Google Business Profile's primary owner, so that system is fine.
    expect(result.findings.some((f) => f.url === "handoff:google-business")).toBe(false);
  });

  it("the same findings, in the same order, every time", async () => {
    const a = await run("marlowe-bar.com", BAR_HANDOFF, { googleLocation: "locations/1234567890" });
    const b = await run("marlowe-bar.com", BAR_HANDOFF, { googleLocation: "locations/1234567890" });
    expect(b.result.findings).toEqual(a.result.findings);
  });

  it("a project where the client is admin everywhere has no findings", async () => {
    const config = { ...BAR_HANDOFF, freelancerEmails: [FREELANCER] };
    const { result } = await run("marlowe-bar.com", config, {
      googleLocation: "locations/1234567890",
      over: {
        "GET https://api.vercel.com/v3/teams/team_harbour01/members?limit=100": {
          status: 200,
          body: {
            members: [
              { uid: "u1", email: CLIENT, role: "OWNER", confirmed: true },
              { uid: "u2", email: FREELANCER, role: "OWNER", confirmed: true },
            ],
            pagination: { next: null },
          },
        },
        "GET https://api.sanity.io/v2021-06-07/projects/abc123xy": {
          status: 200,
          body: {
            id: "abc123xy",
            displayName: "Marlowe Bar",
            members: [
              { id: "su_rosa", role: "administrator" },
              { id: "su_dev", role: "administrator" },
            ],
          },
        },
        "GET https://api.sanity.io/v2021-06-07/projects/abc123xy/users/su_rosa,su_dev": {
          status: 200,
          body: [
            { id: "su_rosa", email: CLIENT },
            { id: "su_dev", email: FREELANCER },
          ],
        },
      },
    });
    expect(result.findings).toEqual([]);
    expect(result.failed).toEqual([]);
  });

  it("a personal Vercel account owned by the client is a medium finding and nothing else", async () => {
    const { result } = await run("juniper-coaching.com", COACH_HANDOFF, {
      env: { ...ENV, SANITY_PROJECT_ID: undefined },
    });
    expect(result.findings.map((f) => [f.checkId, f.severity])).toEqual([
      ["personal-account", "medium"],
    ]);
    expect(result.findings[0]?.evidence).toContain("a***@juniper-coaching.example");
    expect(JSON.stringify(result.findings)).not.toContain(COACH);
  });

  it("a token that may not list Vercel's members is could-not-check for Vercel only", async () => {
    const { result } = await run("marlowe-bar.com", BAR_HANDOFF, {
      googleLocation: "locations/1234567890",
      over: {
        "GET https://api.vercel.com/v3/teams/team_harbour01/members?limit=100": { status: 403 },
      },
    });
    expect(result.findings.filter((f) => f.url === "handoff:vercel")).toEqual([]);
    expect(result.findings.filter((f) => f.url === "handoff:sanity").length).toBeGreaterThan(0);
    const urls = new Set(result.couldNotCheck.map((c) => c.url));
    expect(urls).toEqual(new Set(["handoff:vercel"]));
    expect(result.couldNotCheck.every((c) => /Vercel/.test(c.reason) && /403/.test(c.reason))).toBe(
      true,
    );
  });

  it("no client address: nothing is judged, and each check says so", async () => {
    const { result } = await run(
      "marlowe-bar.com",
      { freelancerEmails: [FREELANCER] },
      { googleLocation: "locations/1234567890" },
    );
    expect(result.findings.filter((f) => f.checkId === "client-not-admin")).toEqual([]);
    expect(result.couldNotCheck.some((c) => /clientEmails/.test(c.reason))).toBe(true);
  });

  it("only GET and HEAD are ever sent", async () => {
    const { seen } = await run("marlowe-bar.com", BAR_HANDOFF, {
      googleLocation: "locations/1234567890",
    });
    expect(new Set(seen.map((s) => s.method))).toEqual(new Set(["GET"]));
  });

  it("a site that does not answer is read anyway", async () => {
    const { result, unreachable } = await run("marlowe-bar.com", BAR_HANDOFF, {
      googleLocation: "locations/1234567890",
      over: {
        "GET https://marlowe-bar.com/": {
          status: 0,
          fail: Object.assign(new Error("getaddrinfo ENOTFOUND marlowe-bar.com"), {
            code: "ENOTFOUND",
          }),
        },
        "GET http://marlowe-bar.com/": {
          status: 0,
          fail: Object.assign(new Error("getaddrinfo ENOTFOUND marlowe-bar.com"), {
            code: "ENOTFOUND",
          }),
        },
      },
    });
    expect(unreachable).toBeDefined();
    expect(result.findings.some((f) => f.checkId === "single-admin")).toBe(true);
  });
});
